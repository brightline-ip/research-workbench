import { requiresExternalEvidence } from '../public/report-model.js';
const stopwords=new Set('about after again against also among because been being between could does doing during each from further have having into itself most other over same should some such than that their them then there these they this those through under very what when where which while will with would your article section court states party parties claim claims provides'.split(' '));
const terms=text=>new Set(String(text||'').toLowerCase().split(/[^a-z0-9§]+/).filter(token=>token.length>=4&&!stopwords.has(token)));
const overlap=(left,right)=>{let shared=0;for(const token of left)if(right.has(token))shared++;return shared/Math.max(1,Math.min(left.size,right.size))};
const citationKey=value=>String(value||'').toLowerCase().replace(/\s+/g,' ').trim();

export function planDiscoveryGroups(assertions,{maxGroupSize=8,similarityThreshold=.42}={}){
 const groups=[];
 for(const assertion of assertions.filter(requiresExternalEvidence)){
  const citation=citationKey(assertion.citation_as_written),assertionTerms=terms(`${assertion.normalized_proposition} ${assertion.assertion_text}`);
  let target=citation?groups.find(group=>group.citation===citation&&group.assertions.length<maxGroupSize):groups.find(group=>!group.citation&&group.assertion_class===assertion.assertion_class&&group.assertions.length<maxGroupSize&&overlap(group.terms,assertionTerms)>=similarityThreshold);
  if(!target){target={citation:citation||null,assertion_class:assertion.assertion_class,terms:new Set(assertionTerms),assertions:[]};groups.push(target)}
  target.assertions.push(assertion);for(const token of assertionTerms)target.terms.add(token);
 }
 return groups.map((group,index)=>({group_index:index,group_key:group.citation?`citation:${group.citation}`:`semantic:${group.assertion_class}:${[...group.terms].sort().slice(0,6).join('-')}`,assertions:group.assertions}));
}

export function estimateDiscoveryUsage(assertions,policy={}){
 const groups=planDiscoveryGroups(assertions,policy),budget=Math.min(Number(policy.max_external_queries??40),groups.length),perSearchLow=Number(policy.estimated_search_cost_low??.035),perSearchHigh=Number(policy.estimated_search_cost_high??.10),minutesLow=Number(policy.estimated_minutes_per_group_low??.35),minutesHigh=Number(policy.estimated_minutes_per_group_high??1.5);
 return{assertions_requiring_sources:assertions.filter(requiresExternalEvidence).length,planned_groups:groups.length,max_external_queries:budget,estimated_cost_usd_low:Number((budget*perSearchLow).toFixed(2)),estimated_cost_usd_high:Number((budget*perSearchHigh).toFixed(2)),estimated_runtime_minutes_low:Math.max(1,Math.ceil(budget*minutesLow)),estimated_runtime_minutes_high:Math.max(2,Math.ceil(budget*minutesHigh)),assumptions:'Estimate covers external discovery and acquisition only; warehouse hits reduce actual calls and time. Source-server latency can increase runtime. Verification is separate.'};
}
