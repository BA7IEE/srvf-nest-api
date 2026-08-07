import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import type {
  AppRegistrationFormDto,
  PutAppManagedRegistrationFormDto,
  RegistrationFormDefinitionInputDto,
} from './dto/app/app-registration-form.dto';
import {
  canonicalizeRegistrationFormDefinition,
  registrationFormDefinitionFromStoredFields,
  type CanonicalRegistrationFormDefinition,
} from './registration-form-definition';

type PrismaTx = Prisma.TransactionClient;

const formFieldSelect = {
  fieldCode: true,
  typeCode: true,
  label: true,
  helpText: true,
  required: true,
  visibilityCode: true,
  exportable: true,
  sortOrder: true,
  minValue: true,
  maxValue: true,
  minLength: true,
  maxLength: true,
  maxSelections: true,
  optionsJson: true,
} as const satisfies Prisma.RegistrationFormFieldSelect;

const formVersionSelect = {
  id: true,
  activityId: true,
  version: true,
  statusCode: true,
  workflowRevision: true,
  schemaHash: true,
  fields: {
    select: formFieldSelect,
    orderBy: [{ sortOrder: 'asc' }, { fieldCode: 'asc' }],
  },
} as const satisfies Prisma.RegistrationFormVersionSelect;

type FormVersionRow = Prisma.RegistrationFormVersionGetPayload<{
  select: typeof formVersionSelect;
}>;

export interface RegistrationFormTarget {
  definition: CanonicalRegistrationFormDefinition;
  schemaHash: string;
}

export interface RegistrationFormResolvedConfig {
  formVersionId: string;
  version: number;
  schemaHash: string;
}

@Injectable()
export class RegistrationFormVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ActivityDraftAuditRecorder,
  ) {}

  async getManaged(
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<AppRegistrationFormDto | null> {
    const activity = await this.prisma.activity.findFirst({
      where: this.managedActivityWhere(activityId, user),
      select: { statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (activity.statusCode !== 'draft' && activity.statusCode !== 'published') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
    const version = await this.currentVersionForActivity(this.prisma, activityId, activity.statusCode);
    return version ? this.toDto(version) : null;
  }

  async putManaged(
    activityId: string,
    dto: PutAppManagedRegistrationFormDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppRegistrationFormDto | null> {
    const target = dto.form === null ? null : this.canonicalizeInput(dto.form);
    return this.prisma.$transaction(async (tx) => {
      const activity = await this.lockManagedActivity(tx, activityId, user);
      if (activity.statusCode !== 'draft') {
        throw new BizException(
          activity.statusCode === 'published'
            ? BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED
            : BizCode.ACTIVITY_STATUS_INVALID,
        );
      }
      const existing = await tx.registrationFormVersion.findFirst({
        where: { activityId, statusCode: 'draft' },
        select: formVersionSelect,
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      });
      if (target === null) {
        if (!existing) return null;
        await tx.registrationFormVersion.update({
          where: { id: existing.id },
          data: { statusCode: 'retired', retiredAt: new Date() },
        });
        await this.audit.log({
          activityId,
          formVersionId: existing.id,
          operation: 'draft-registration-form-update',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
          changedFields: ['form'],
        });
        return null;
      }
      if (existing && this.sameTarget(this.targetFromVersion(existing), target)) {
        // Exact canonical PUT is an idempotent no-op: no form row and no audit row.
        return this.toDto(existing);
      }
      const now = new Date();
      if (existing) {
        await tx.registrationFormVersion.update({
          where: { id: existing.id },
          data: { statusCode: 'retired', retiredAt: now },
        });
      }
      const created = await this.createVersion(tx, {
        activityId,
        version: await this.nextVersion(tx, activityId),
        statusCode: 'draft',
        workflowRevision: activity.workflowRevision,
        schemaHash: null,
        definition: target.definition,
      });
      await this.audit.log({
        activityId,
        formVersionId: created.id,
        operation: 'draft-registration-form-update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
        changedFields: ['form'],
      });
      return this.toDto(created);
    });
  }

  /** Snapshot read: draft uses latest draft, every other lifecycle reads the active version. */
  async currentTarget(
    tx: PrismaTx,
    activityId: string,
    activityStatus: string,
  ): Promise<RegistrationFormTarget | null> {
    const version = await this.currentVersionForActivity(tx, activityId, activityStatus);
    return version ? this.targetFromVersion(version) : null;
  }

  /** Current active pointer only; it is deliberately small enough for RuleSnapshot resolvedConfig. */
  async activeResolvedConfig(
    tx: PrismaTx,
    activityId: string,
  ): Promise<RegistrationFormResolvedConfig | null> {
    const version = await tx.registrationFormVersion.findFirst({
      where: { activityId, statusCode: 'active' },
      select: { id: true, version: true, schemaHash: true },
    });
    if (!version) return null;
    if (!version.schemaHash) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    return { formVersionId: version.id, version: version.version, schemaHash: version.schemaHash };
  }

  /**
   * Called inside the Activity-root transaction after the proposal target has been applied.
   * `nextWorkflowRevision` is supplied by the proposal applier, making the activation's frozen
   * revision explicit rather than inferred from a later reread.
   */
  async applyPublishedTarget(
    tx: PrismaTx,
    input: {
      activityId: string;
      requestType: 'initial' | 'change';
      target: RegistrationFormTarget | null;
      nextWorkflowRevision: number;
      at: Date;
    },
  ): Promise<RegistrationFormResolvedConfig | null> {
    const active = await tx.registrationFormVersion.findFirst({
      where: { activityId: input.activityId, statusCode: 'active' },
      select: formVersionSelect,
    });
    if (input.requestType === 'initial') {
      if (input.target === null) {
        if (active) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
        return null;
      }
      if (active) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      const draft = await tx.registrationFormVersion.findFirst({
        where: { activityId: input.activityId, statusCode: 'draft' },
        select: formVersionSelect,
        orderBy: [{ version: 'desc' }, { id: 'desc' }],
      });
      if (!draft || !this.sameTarget(this.targetFromVersion(draft), input.target)) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH);
      }
      const activated = await tx.registrationFormVersion.update({
        where: { id: draft.id },
        data: {
          statusCode: 'active',
          workflowRevision: input.nextWorkflowRevision,
          schemaHash: input.target.schemaHash,
          activatedAt: input.at,
          retiredAt: null,
        },
        select: { id: true, version: true, schemaHash: true },
      });
      if (!activated.schemaHash) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      return {
        formVersionId: activated.id,
        version: activated.version,
        schemaHash: activated.schemaHash,
      };
    }

    if (input.target === null) {
      if (!active) return null;
      await this.retireActiveAndRevokeSessions(tx, active.id, input.at);
      return null;
    }
    if (active && this.sameTarget(this.targetFromVersion(active), input.target)) {
      if (!active.schemaHash || active.schemaHash !== input.target.schemaHash) {
        throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      }
      return { formVersionId: active.id, version: active.version, schemaHash: active.schemaHash };
    }
    if (active) await this.retireActiveAndRevokeSessions(tx, active.id, input.at);
    const created = await this.createVersion(tx, {
      activityId: input.activityId,
      version: await this.nextVersion(tx, input.activityId),
      statusCode: 'active',
      workflowRevision: input.nextWorkflowRevision,
      schemaHash: input.target.schemaHash,
      activatedAt: input.at,
      definition: input.target.definition,
    });
    if (!created.schemaHash) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    return { formVersionId: created.id, version: created.version, schemaHash: created.schemaHash };
  }

  /** Clone copies only a definition, never answers, sessions, Attachment or review history. */
  async cloneFromSource(
    tx: PrismaTx,
    sourceActivityId: string,
    sourceStatus: string,
    targetActivityId: string,
  ): Promise<void> {
    const source = await this.currentVersionForActivity(tx, sourceActivityId, sourceStatus);
    if (!source) return;
    await this.createVersion(tx, {
      activityId: targetActivityId,
      version: 1,
      statusCode: 'draft',
      workflowRevision: 0,
      schemaHash: null,
      definition: this.targetFromVersion(source).definition,
    });
  }

  private canonicalizeInput(input: RegistrationFormDefinitionInputDto): RegistrationFormTarget {
    const canonical = canonicalizeRegistrationFormDefinition(input);
    return { definition: canonical.definition, schemaHash: canonical.schemaHash };
  }

  private targetFromVersion(version: FormVersionRow): RegistrationFormTarget {
    const canonical = registrationFormDefinitionFromStoredFields(version.fields);
    return { definition: canonical.definition, schemaHash: canonical.schemaHash };
  }

  private sameTarget(left: RegistrationFormTarget, right: RegistrationFormTarget): boolean {
    return left.schemaHash === right.schemaHash;
  }

  private async currentVersionForActivity(
    client: PrismaTx | PrismaService,
    activityId: string,
    activityStatus: string,
  ): Promise<FormVersionRow | null> {
    return client.registrationFormVersion.findFirst({
      where: {
        activityId,
        statusCode: activityStatus === 'draft' ? 'draft' : 'active',
      },
      select: formVersionSelect,
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
    });
  }

  private async nextVersion(tx: PrismaTx, activityId: string): Promise<number> {
    const latest = await tx.registrationFormVersion.aggregate({
      where: { activityId },
      _max: { version: true },
    });
    return (latest._max.version ?? 0) + 1;
  }

  private async createVersion(
    tx: PrismaTx,
    input: {
      activityId: string;
      version: number;
      statusCode: 'draft' | 'active';
      workflowRevision: number;
      schemaHash: string | null;
      activatedAt?: Date;
      definition: CanonicalRegistrationFormDefinition;
    },
  ): Promise<FormVersionRow> {
    return tx.registrationFormVersion.create({
      data: {
        activityId: input.activityId,
        version: input.version,
        statusCode: input.statusCode,
        workflowRevision: input.workflowRevision,
        schemaHash: input.schemaHash,
        activatedAt: input.activatedAt ?? null,
        fields: {
          create: input.definition.fields.map((field) => ({
            fieldCode: field.fieldCode,
            typeCode: field.typeCode,
            label: field.label,
            helpText: field.helpText,
            required: field.required,
            visibilityCode: field.visibilityCode,
            exportable: field.exportable,
            sortOrder: field.sortOrder,
            minValue: field.minValue,
            maxValue: field.maxValue,
            minLength: field.minLength,
            maxLength: field.maxLength,
            maxSelections: field.maxSelections,
            optionsJson:
              field.options === null
                ? Prisma.DbNull
                : (field.options as unknown as Prisma.InputJsonValue),
          })),
        },
      },
      select: formVersionSelect,
    });
  }

  private async retireActiveAndRevokeSessions(
    tx: PrismaTx,
    formVersionId: string,
    at: Date,
  ): Promise<void> {
    await tx.registrationUploadSession.updateMany({
      where: { formVersionId, statusCode: 'active' },
      data: { statusCode: 'revoked' },
    });
    await tx.registrationFormVersion.update({
      where: { id: formVersionId },
      data: { statusCode: 'retired', retiredAt: at },
    });
  }

  private async lockManagedActivity(
    tx: PrismaTx,
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<{ statusCode: string; workflowRevision: number }> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const activity = await tx.activity.findFirst({
      where: this.managedActivityWhere(activityId, user),
      select: { statusCode: true, workflowRevision: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private managedActivityWhere(
    activityId: string,
    user: CurrentUserPayload,
  ): Prisma.ActivityWhereInput {
    if (user.role === Role.SUPER_ADMIN) return { id: activityId, deletedAt: null };
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    return { id: activityId, deletedAt: null, initiatorMemberId: user.memberId };
  }

  private toDto(version: FormVersionRow): AppRegistrationFormDto {
    const canonical = this.targetFromVersion(version).definition;
    return { version: version.version, fields: canonical.fields };
  }
}
