import test from 'node:test';
import assert from 'node:assert/strict';
import { usagePeriod, tokenCost, warningThresholds, usagePolicyBody, developmentUsagePolicy, provisionalPlans } from '../src/services/usage-validation.js';
import { loadConfig } from '../src/config.js';

test('usage periods are half-open calendar months in Lagos, including leap years', () => {
  assert.equal(usagePeriod(new Date('2028-02-29T22:59:59Z')).end.toISOString(),'2028-02-29T23:00:00.000Z');
  assert.equal(usagePeriod(new Date('2028-02-29T23:00:00Z')).start.toISOString(),'2028-02-29T23:00:00.000Z');
});
test('costs and warning boundaries use exact integer micro-USD without floating rounding', () => {
  assert.equal(tokenCost(123,456),2526n);
  assert.equal(tokenCost(32768,4000,999999999n,999999999n),36767999963232n);
  assert.throws(() => tokenCost(1.5,0)); assert.throws(() => tokenCost(-1,0));
  assert.deepEqual(warningThresholds(69n,100n),[]);
  assert.deepEqual(warningThresholds(85n,100n),[70,85]);
  assert.deepEqual(warningThresholds(100n,100n),[70,85,100]);
  assert.deepEqual(warningThresholds(0n,0n),[70,85,100]);
});
test('provisional plans and bounded policy input reject unsafe financial configuration', () => {
  assert.deepEqual(provisionalPlans,{STARTER:300,GROWTH:1000,PRO:3000});
  const input = { ...developmentUsagePolicy(), monthlyCapMicroUsd:'100', minimumReservationMicroUsd:'1', maxRequestMicroUsd:'50' };
  assert.equal(usagePolicyBody.parse(input).monthlyCapMicroUsd,100n);
  for (const patch of [{monthlyCapMicroUsd:1.5},{monthlyCapMicroUsd:'1.5'},{monthlyCapMicroUsd:'-1'},
    {minimumReservationMicroUsd:'51'},{maxRetries:2},{maxInputBytes:32769},{tenantId:'foreign'}]) {
    assert.equal(usagePolicyBody.safeParse({...input,...patch}).success,false);
  }
  assert.throws(() => loadConfig({DATABASE_URL:'postgresql://localhost/test',USAGE_SIMULATION_GLOBAL_CAP_MICRO_USD:'invalid'}),/USAGE_SIMULATION/);
});
