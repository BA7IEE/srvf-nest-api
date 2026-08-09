# External I/O Inventory - Phase 0

> Scope: production source under src only; test doubles and local filesystem providers are excluded.
> Method: searched HTTP fetch calls and SDK transport calls, then read the provider and outbox call paths.
> This is an observation table for Constitution C7. It changes no producer, transaction, worker, retry, or provider behavior.

## Classification rule

- durable-async-effect (should use outbox): an externally visible business effect that is not currently dispatched from the notification outbox.
- sync-integration: a request-time handshake, OCR, storage signing/object verification, or real-time provider query. C7 applicability remains a maintainer decision.
- already-outbox: the actual provider effect is reached from NotificationOutbox handlers after the intent/worker boundary.

## Outbound call points

| # | provider capability | evidence | caller boundary | classification | Phase 0 rationale |
|---:|---|---|---|---|---|
| 1 | Tencent SMS verification-code send | src/modules/sms/providers/tencent-sms.provider.ts:57,116 | login, password reset, step-up, recruitment identity verification | sync-integration | Short-lived identity-verification handshake; whether this SMS subtype belongs in C7 durable-effect scope remains for maintainer decision. |
| 2 | Tencent SMS birthday greeting | src/modules/sms/providers/tencent-sms.provider.ts:64,116; src/modules/notifications/notification-outbox.handlers.ts:1033 | notification worker | already-outbox | Provider send happens in the existing outbox delivery path. |
| 3 | Tencent SMS admin notification | src/modules/sms/providers/tencent-sms.provider.ts:71,116; src/modules/notifications/notification-sms-dispatch.service.ts:213 | notification worker / recipient dispatch | already-outbox | Per-recipient send is the effect after notification dispatch ownership and guard checks. |
| 4 | WeChat code-to-session exchange | src/modules/wechat/providers/wechat.provider.ts:103,115; src/modules/auth/login-wechat.service.ts:122 | login and identity binding | sync-integration | Login handshake; it has no durable message intent. |
| 5 | WeChat access-token acquisition for subscription delivery | src/modules/wechat/providers/wechat.provider.ts:176,200; src/modules/notifications/notification-outbox.handlers.ts:496 | notification worker | already-outbox | Token acquisition is a prerequisite of an already-outboxed subscription-message effect. |
| 6 | WeChat subscription-message send | src/modules/wechat/providers/wechat.provider.ts:253,265; src/modules/notifications/notification-wechat-dispatch.service.ts:290 | notification worker | already-outbox | The send is executed by the outbox delivery path. |
| 7 | WeCom OAuth code exchange | src/modules/wecom/providers/wecom.provider.ts:245; src/modules/auth/login-wecom.service.ts:402 | login / account binding | sync-integration | Request-time OAuth identity handshake. |
| 8 | WeCom access-token and agent metadata reads | src/modules/wecom/providers/wecom.provider.ts:276,322,444,493 | OAuth route and notification delivery preparation | sync-integration | Real-time provider query or credential exchange; delivery use is separately captured below. |
| 9 | WeCom text-card message send | src/modules/wecom/providers/wecom.provider.ts:355; src/modules/notifications/notification-outbox.handlers.ts:786 | notification worker | already-outbox | The provider effect is only reached through the existing outbox handler. |
| 10 | Tencent real-name OCR recognize | src/modules/realname/providers/tencent-realname.provider.ts:124,160; src/modules/recruitment/recruitment-applications.service.ts:594 | recruitment submit / recognize | sync-integration | Request-time OCR/anti-forgery decision input, explicitly one of the C7 decision examples. |
| 11 | COS object put and delete | src/modules/storage/providers/cos.provider.ts:91,121 | attachment and recruitment storage workflows | sync-integration | Object I/O is currently part of request-time upload/cleanup workflows; it is not a notification effect. |
| 12 | COS upload/download URL signing | src/modules/storage/providers/cos.provider.ts:131,165 | attachment upload/download API | sync-integration | Storage signing is explicitly a C7 scope-decision example. |
| 13 | COS head, fixed-prefix read, and object hash | src/modules/storage/providers/cos.provider.ts:205,242,258 | upload confirmation and content validation | sync-integration | Real-time storage verification query; no durable recipient effect. |

## Negative findings and boundary notes

- No direct HTTP or SDK transport call was found in notification business writers outside the worker-facing provider routes above.
- Dev-stub providers and LocalStorageProvider were excluded because they do not contact an external service.
- The table distinguishes an outbound provider call from its caller. A provider can serve both a sync integration and an outbox effect; rows 1 to 3 and 4 to 6 make those different call paths explicit.
- No C7 enforcement is proposed in Phase 0. The maintainer must decide whether verification SMS and storage object mutation are inside the durable-effect rule or remain synchronous integrations.

## C7 decisions required

1. Confirm the durable-effect boundary for verification SMS.
2. Confirm the treatment of COS put/delete relative to business transactions.
3. Confirm that OAuth, WeChat code exchange, and OCR stay in the sync-integration exception.
4. Confirm the existing notification outbox as the sole delivery path for WeChat, WeCom, birthday SMS, and admin SMS.
