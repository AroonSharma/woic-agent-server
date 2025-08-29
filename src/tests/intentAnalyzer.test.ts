import { IntentAnalyzer } from '../intent-analyzer';

export const name = 'intentAnalyzer';

export async function run(assert: (cond: any, msg: string) => void) {
  const ia = new IntentAnalyzer();
  const res1 = ia.analyzeIntent('I want to buy car insurance');
  assert(res1.intent.includes('customer.identification.new') || res1.intent.includes('coverage'), 'should detect new or coverage intent');
  const res2 = ia.analyzeIntent('my policy number is AB1234567');
  assert(!!res2.entities.policy_number, 'should extract policy number');
}
