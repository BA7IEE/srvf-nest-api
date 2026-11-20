"""Build the cross-case driver from the official PR head (no application source changes)."""
import sys, subprocess
from pathlib import Path
repo=Path(sys.argv[1])
sha="104e524c0b76826a79b1d48fad37fb07dcdfb8e8"
def source(name):
    return subprocess.check_output(["git","-C",repo,"show",sha+":tests/render/"+name],text=True)
def replace(s,old,new):
    assert s.count(old)==1, old
    return s.replace(old,new)
p=Path('drivers')
p.mkdir(exist_ok=True)
s=source('simple_freeze_server.cjs')
s=replace(s,'T41 单场次变更','T42 五类指标交叉')
s=replace(s,'/T36 指标/','/T37 全指标/')
s=replace(s,'  if (change && !inspect) {','''  const metricPanel = p.locator(".el-collapse-item.is-active")
    .filter({ has: p.getByRole("button",{name:"指标集合",exact:true}) }).last();
  for (const value of ["T37 全指标","T36 完成","往返次数","实走里程","现场简述","场地类型",
    "boolean","non_negative_integer","non_negative_decimal","short_text","single_choice",
    "次","公里","10.5","24","开放场地","室内场馆"]) {
    await metricPanel.getByText(value,{exact:true}).first().waitFor({state:"visible"});
  }
  const requiredFlags=metricPanel.locator(".frozen-fact")
    .filter({has:p.locator("dt").filter({hasText:/^必填$/})})
    .locator(":scope > dt").filter({hasText:/^必填$/});
  assert.equal(await requiredFlags.count(),5);
  for(const flag of await requiredFlags.all()){
    assert.equal(await flag.locator("..").locator(":scope > dd").innerText(),"是");
  }
  console.log("PASS five required definitions, limits and both options visible on review "+id);
  if (change && !inspect) {''')
s=replace(s,'  if (status === 200) assert.equal(approved.data.status, "approved");','''  if(status===200){
    assert.equal(approved.data.status,"approved");
    const snap=approved.data.snapshot;
    assert.equal(snap.metricRequirementCode,"required");
    assert.equal(snap.metricSetPointer.code,"t37_full_set");
    assert.match(snap.metricSetPointer.definitionHash,/^[a-f0-9]{64}$/);
    assert.deepEqual(snap.base.metricSetPointer,snap.metricSetPointer);
  }''')
(p/'simple_freeze_server.cjs').write_text(s)
s=source('simple_published_layout.cjs')
s=replace(s,'  reviewer.off("request", count);','''  await reviewer.route(detail, async route=>{
    const response=await route.fetch(),body=await response.json();
    const [set]=body.data.frozenMetricSets;
    assert.equal(set.definition.items.length,5);
    assert.equal(set.metrics.length,5);
    set.metrics.pop();
    await route.fulfill({response,json:body});
  });
  await reviewer.reload();
  await reviewer.getByText(/缺少与冻结指针一致的完整指标集/).first().waitFor();
  assert(await reviewer.getByRole("button",{name:"通过活动变更",exact:true}).isDisabled());
  assert.equal(approvalRequests,0);
  console.log("PASS incomplete five-metric set and undisclosed place difference each blocked with zero approval requests");
  await reviewer.unroute(detail);
  reviewer.off("request", count);''')
(p/'simple_published_layout.cjs').write_text(s)
