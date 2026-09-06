import { metricObject } from './activity-metric-definition';
import {
  parseActivityMetricSelection,
  type ActivityMetricSelection,
} from './activity-metric-selection';
import {
  parseActivityTemplateDefinitionV2,
  type ActivityTemplateDefinitionV2,
} from './activity-template-definition-v2';

export interface ActivityTemplateDefinitionV3 extends ActivityTemplateDefinitionV2 {
  readonly metricSelection: ActivityMetricSelection;
}

/** V3 is an independent branch; V1/V2 retain their original grammar and hash interpretation. */
export function parseActivityTemplateDefinitionV3(value: unknown): ActivityTemplateDefinitionV3 {
  const v = metricObject(value, ['activity', 'sessions', 'registrationForm', 'metricSelection']);
  return {
    ...parseActivityTemplateDefinitionV2({
      activity: v.activity,
      sessions: v.sessions,
      registrationForm: v.registrationForm,
    }),
    metricSelection: parseActivityMetricSelection(v.metricSelection),
  };
}
