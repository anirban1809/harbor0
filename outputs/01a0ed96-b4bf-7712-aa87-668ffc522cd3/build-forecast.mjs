import fs from 'node:fs/promises';
import {Workbook, SpreadsheetFile} from '@oai/artifact-tool';
const dir='/Users/anirban/Documents/Code/files/outputs/01a0ed96-b4bf-7712-aa87-668ffc522cd3';
const wb=Workbook.create();
const f=wb.worksheets.add('Forecast');
const a=wb.worksheets.add('Assumptions');
const market=wb.worksheets.add('Market prices');
const money='$'+'#,##0;($#,##0);"–"';
const decimal='$'+'0.00;($0.00);"–"';
for(const s of [f,a,market]){
 s.showGridLines=false;
 s.getRange('A1:K70').format.font={name:'Arial',size:10,color:'#182B3A'};
 s.getRange('A1:K70').format.rowHeight=22;
 s.getRange('A1:A70').format.columnWidth=3;
 s.getRange('B1:B70').format.columnWidth=39;
 s.getRange('C1:K70').format.columnWidth=16;
 s.getRange('B2').format.font={size:16,bold:true};
}
f.tabColor='#183D52'; a.tabColor='#527F94';
const val=(s,c,v)=>s.getRange(c).values=[[v]];
const formula=(s,c,v)=>{s.getRange(c).formulas=[[v]];s.getRange(c).format.font.color=v.includes('Assumptions')?'#008000':'#182B3A';};
function header(s,r,text,end='H'){val(s,`B${r}`,text);s.getRange(`B${r}:${end}${r}`).format={fill:'#183D52',font:{color:'#FFFFFF',bold:true},rowHeight:25};}
val(a,'B2','Harbor0 forecast assumptions');
val(a,'B3','Planning model, 29 September 2026. Blue cells are editable.');
a.getRange('B3').format.font.italic=true;
a.getRange('E1:E70').format.columnWidth=3;
a.getRange('F1:F70').format.columnWidth=99;
header(a,5,'Business and usage drivers','D');
a.getRange('B6:D6').values=[['Assumption','Value','Unit']];
const inputs=[
 ['Accounts in selected month',1000,'accounts','All free accounts still holding data, plus paying accounts. Not monthly active users.'],
 ['Paying share of accounts',0.02,'%','Illustrative installed-base share, not a measured signup conversion rate.'],
 ['Average free storage',20,'GB/account','Time-weighted monthly average per free account, including inactive retained data.'],
 ['Weighted paid capacity utilization',null,'%','Calculated from plan mix and the separate usage assumptions in C33:C34.'],
 ['Additional physical storage',0.10,'%','Extra temporary ZIPs, staging and overhead. Not an independent backup replica.'],
 ['R2 standard storage rate',0.015,'USD/GB-month','Published Cloudflare price. No free-tier credits assumed.'],
 ['Payment fee percentage',0.05,'%','Paddle public benchmark. Provider not selected or connected. Web billing only.'],
 ['Payment fee per transaction',0.50,'USD/month','One successful monthly transaction per paid account.'],
 ['Refund / FX / fee contingency',0.01,'% of revenue','Planning allowance, not a vendor quote.'],
 ['Free nonstorage infrastructure',0.20,'USD/account','Allowance for AWS, R2 requests, email and logs. Must be load-tested.'],
 ['Paid nonstorage infrastructure',0.60,'USD/account','Allowance for AWS, R2 requests, ZIP work, email and logs. Must be load-tested.'],
 ['Paid customer support allowance',0.75,'USD/account','Variable cash provision for help. Founder time is paid from owner draw.'],
 ['Fixed tools, admin and base hosting',300,'USD/month','Planning allowance.'],
 ['Marketing cash budget',500,'USD/month','Small organic-led launch budget. Does not imply this buys the forecast user count.'],
 ['Other monthly operating contingency',400,'USD/month','Accounting, incidents and periodic specialist help.'],
 ['Tax reserve',0.30,'% of positive profit','Cash planning haircut, not an Indian tax calculation or statutory rate.'],
 ['Business retention after tax reserve',0.10,'%','Kept inside the business after the illustrative tax reserve.'],
 ['Desired owner draw',2500,'USD/month','Desired spendable draw after the model reserves.'],
 ['Planning USD to INR rate',96,'INR/USD','Rounded from approximately INR 95.98 on 29 September 2026.'],
 ['Runway months',6,'months','Cash target covering operating costs plus the desired owner draw.'],
];
inputs.forEach((x,i)=>{const r=i+7;a.getRange(`B${r}:D${r}`).values=[[x[0],x[1],x[2]]];val(a,`F${r}`,x[3]);});
a.getRange('C7:C26').format={font:{color:'#0000FF'},fill:'#FFF3CE',numberFormat:'0.00'};
for(const r of [8,10,11,13,15,22,23])a.getRange(`C${r}`).setNumberFormat('0.0%');
a.getRange('C12').setNumberFormat('$0.000');
for(const r of [7,9,24,25,26])a.getRange(`C${r}`).setNumberFormat('#,##0');
for(const r of [8,11,13,15,22,23,33,34])a.dataValidations.add({range:`C${r}`,rule:{type:'decimal',operator:'between',formula1:0,formula2:1}});
a.dataValidations.add({range:'C9',rule:{type:'decimal',operator:'between',formula1:0,formula2:100}});
header(a,29,'Proposed monthly plans','D');
a.getRange('B30:D32').values=[['Total capacity (GB)','Price (USD)','Paid customer mix'],[500,10,.6],[1000,20,.4]];
a.getRange('B31:D32').format={font:{color:'#0000FF'},fill:'#FFF3CE'};
a.getRange('C31:C32').setNumberFormat(money);a.getRange('D31:D32').setNumberFormat('0%');
a.getRange('B33:D34').values=[['500 GB plan utilization',.6,'%'],['1 TB plan utilization',.4,'%']];
a.getRange('C33:C34').format={font:{color:'#0000FF'},fill:'#FFF3CE',numberFormat:'0.0%'};
formula(a,'C10','=(B31*D31*C33+B32*D32*C34)/SUMPRODUCT(B31:B32,D31:D32)');
a.getRange('C10').format.fill='#FFFFFF';
val(a,'F31','Capacity includes the original 100 GB. 1 TB = 1,000 GB.');
val(a,'F32','Prices exclude sales tax. No annual discounts, app-store commissions or new paid features assumed.');
val(a,'F33','User assumption: the average 500 GB customer stores 300 GB.');
val(a,'F34','User assumption: the average 1 TB customer stores 400 GB.');
val(a,'B54','Plan mix assumption');val(a,'F54','60% of paying customers on 500 GB and 40% on 1 TB, carried forward separately from usage.');
val(a,'B59','Lower-cost storage reference');val(a,'F59','Backblaze B2: $0.00695/GB-month; https://www.backblaze.com/cloud-storage/pricing');
val(a,'F60','B2 egress beyond 3x average storage is $0.01/GB unless qualifying partner routing applies.');
val(a,'F61','Changing C12 alone tests storage price only. Other-provider egress/migration costs are not included.');
header(a,37,'Sources and scope','D');
const notes=[
 ['R2 storage and requests','https://developers.cloudflare.com/r2/pricing/'],
 ['Paddle payment benchmark','https://www.paddle.com/pricing'],
 ['USD / INR reference','https://wise.com/us/currency-converter/usd-to-inr-rate/history/29-09-2026'],
 ['Product architecture','Harbor0 README and architecture: private R2, AWS metadata/auth/API, 100 GB free.'],
 ['Storage basis','Billable GB-month is approximated by account count × average GB × physical overhead.'],
 ['Traffic basis','R2 direct egress is free. Request and AWS processing costs are included in the per-account allowance.'],
 ['Model limitations','No actual invoices, customer cohorts, usage distribution, CAC or churn data were supplied.'],
 ['Acquisition and timing','Scale scenarios, not a dated growth prediction. Churn affects how long it takes to reach each scale.'],
 ['Accounting scope','Monthly subscriptions and recurring cash costs. No debt, capex, setup costs or second storage replica.'],
 ['Tax scope','Revenue excludes customer sales tax. Input GST recovery and actual founder/entity tax are not modelled.'],
 ['Cost scaling','Per-account allowances scale with users. Fixed costs stay flat and may need step-ups at larger scale.'],
 ['Unit economics','Paid plan contribution excludes free-user subsidies and fixed costs; business profit includes both.'],
 ['Sync limitation','Released temporary sync bytes may generate usage without persistent storage upgrades.'],
 ['Launch limitation','Checkout/provider/webhook integration is not yet connected in the repository.'],
];
notes.forEach((n,i)=>{val(a,`B${38+i}`,n[0]);val(a,`F${38+i}`,n[1]);});
a.freezePanes.freezeRows(6);
val(f,'B2','Harbor0 monthly profit forecast');
val(f,'B3','USD unless stated. Editable assumptions are on the next tab. Scale scenarios, not a growth promise.');
val(f,'B4','500 GB at $10 with 60% usage; 1 TB at $20 with 40% usage.');
val(a,'B4','Paid customer mix and plan utilization are separate assumptions.');
f.getRange('B3').format.font.italic=true;
header(f,5,'Selected month');
const top=[
 ['Total accounts',"='Assumptions'!C7"],['Paying accounts',"=ROUND(C6*'Assumptions'!C8,0)"],['Free accounts','=C6-C7'],
 ['Subscription revenue','=C7*C34'],['Total operating costs','=SUM(C12:C18)'],['Operating profit before reserves','=C9-C10'],
 ['Storage: free and paid','=C8*C37+C7*C38'],['Payment processing',"=C9*'Assumptions'!C13+C7*'Assumptions'!C14"],
 ['Refund / FX contingency',"=C9*'Assumptions'!C15"],['Other infrastructure',"=C8*'Assumptions'!C16+C7*'Assumptions'!C17"],
 ['Customer support allowance',"=C7*'Assumptions'!C18"],['Fixed operating costs','=C43'],['Marketing',"='Assumptions'!C20"],
 ['Tax reserve',"=MAX(0,C11)*'Assumptions'!C22"],['Business retention',"=MAX(0,C11-C19)*'Assumptions'!C23"],
 ['Available owner draw','=MAX(0,C11-C19-C20)'],['Owner draw in INR',"=C21*'Assumptions'!C25"],
 ];
top.forEach(([name,fx],i)=>{val(f,`B${i+6}`,name);formula(f,`C${i+6}`,fx);});
f.getRange('C9:C21').setNumberFormat(money); f.getRange('C22').setNumberFormat('"₹"#,##0');
for(const r of [9,10,11,21,22])f.getRange(`B${r}:C${r}`).format.font.bold=true;
val(f,'E6','Accounts for target draw');formula(f,'H6','=IF(OR(C42<=0,C45<=0),"Not viable",ROUNDUP((C46+C44)/C42,0))');
val(f,'E7','Paying accounts at target');formula(f,'H7','=IF(ISNUMBER(H6),ROUNDUP(H6*\'Assumptions\'!C8,0),"Not viable")');
val(f,'E8','Revenue at target (approx.)');formula(f,'H8','=IF(ISNUMBER(H7),H7*C34,"Not viable")');
val(f,'E10','Operating break-even accounts');formula(f,'H10','=IF(C42<=0,"Not viable",ROUNDUP(C44/C42,0))');
val(f,'E11','Minimum profitable paying share');formula(f,'H11','=IF(C40<=0,"None",C39/(C40+C39))');
val(f,'E13','Runway cash at selected scale');formula(f,'H13',"=(C10+'Assumptions'!C24)*'Assumptions'!C26");
val(f,'E14','Includes costs + target owner draw');
val(f,'E16','Paying share assumption');formula(f,'H16',"='Assumptions'!C8");
val(f,'E17','Average free usage (GB)');formula(f,'H17',"='Assumptions'!C9");
val(f,'E18','Weighted paid capacity utilization');formula(f,'H18',"='Assumptions'!C10");
val(f,'E23','Free cost ceiling before fixed costs');formula(f,'H23','=IF(\'Assumptions\'!C8=1,"n.a.",C40*\'Assumptions\'!C8/(1-\'Assumptions\'!C8))');
f.getRange('H23').setNumberFormat('$0.0000');
val(f,'E20','Target after reserves');formula(f,'H20',"='Assumptions'!C24");
for(const r of [6,7,10,17])f.getRange(`H${r}`).setNumberFormat('#,##0');
for(const r of [8,13,20])f.getRange(`H${r}`).setNumberFormat(money);
for(const r of [11,16,18])f.getRange(`H${r}`).setNumberFormat('0.0%');
header(f,25,'Results at different account counts');
f.getRange('B26:H26').values=[['Total accounts','Paying accounts','Revenue','All operating costs','Operating profit','Owner draw','Draw in INR']];
f.getRange('B26:H26').format={wrapText:true,rowHeight:33,font:{bold:true}};
[1000,5000,10000,25000,50000,100000].forEach((n,i)=>{
 const r=27+i;val(f,`B${r}`,n);
 f.getRange(`C${r}:H${r}`).formulas=[[
 `=ROUND(B${r}*'Assumptions'!$C$8,0)`, `=C${r}*$C$34`,
 `=(B${r}-C${r})*$C$39+C${r}*$C$41+$C$44`,
 `=D${r}-E${r}`,`=MAX(0,F${r})*$C$45`,`=G${r}*'Assumptions'!$C$25`
 ]];
});
f.getRange('B27:C32').setNumberFormat('#,##0'); f.getRange('D27:G32').setNumberFormat(money);f.getRange('H27:H32').setNumberFormat('"₹"#,##0');
header(f,33,'Unit economics and target calculation');
const build=[
 ['Average paid revenue',"=SUMPRODUCT('Assumptions'!C31:C32,'Assumptions'!D31:D32)"],
 ['Average paid capacity (GB)',"=SUMPRODUCT('Assumptions'!B31:B32,'Assumptions'!D31:D32)"],
 ['Average paid usage (GB)',"=C35*'Assumptions'!C10"],
 ['Free storage cost / account',"='Assumptions'!C9*(1+'Assumptions'!C11)*'Assumptions'!C12"],
 ['Paid storage cost / account',"=C36*(1+'Assumptions'!C11)*'Assumptions'!C12"],
 ['All free cost / account',"=C37+'Assumptions'!C16"],
 ['Paid contribution before free subsidy','=C34-C41'],
 ['All paid variable cost / account',"=C38+'Assumptions'!C17+'Assumptions'!C18+C34*('Assumptions'!C13+'Assumptions'!C15)+'Assumptions'!C14"],
 ['Net contribution / total account',"='Assumptions'!C8*C40-(1-'Assumptions'!C8)*C39"],
 ['Fixed costs excluding marketing',"='Assumptions'!C19+'Assumptions'!C21"],
 ['All fixed costs including marketing',"=C43+'Assumptions'!C20"],
 ['Owner share of positive profit',"=(1-'Assumptions'!C22)*(1-'Assumptions'!C23)"],
 ['Required profit for target draw',"=IF(C45>0,'Assumptions'!C24/C45,\"No draw\")"],
 ];
build.forEach(([name,fx],i)=>{val(f,`B${i+34}`,name);formula(f,`C${i+34}`,fx);});
f.getRange('C34:C46').setNumberFormat(decimal);f.getRange('C35:C36').setNumberFormat('#,##0');f.getRange('C45').setNumberFormat('0.0%');
header(f,49,'Plan contribution at 100% storage usage');
f.getRange('B50:G50').values=[['Total GB','Monthly price','Storage cost','Other variable costs','Contribution','Break-even used GB']];
f.getRange('B50:G50').format={wrapText:true,rowHeight:33,font:{bold:true}};
for(let i=0;i<2;i++){
 const r=51+i,j=31+i;
 f.getRange(`B${r}:F${r}`).formulas=[[
 `='Assumptions'!B${j}`,`='Assumptions'!C${j}`,`=B${r}*(1+'Assumptions'!$C$11)*'Assumptions'!$C$12`,
 `=C${r}*('Assumptions'!$C$13+'Assumptions'!$C$15)+'Assumptions'!$C$14+'Assumptions'!$C$17+'Assumptions'!$C$18`,
 `=C${r}-D${r}-E${r}`
 ]];
 formula(f,`G${r}`,`=MAX(0,(C${r}-E${r})/((1+'Assumptions'!$C$11)*'Assumptions'!$C$12))`);
}
f.getRange('C51:F52').setNumberFormat(decimal);f.getRange('G51:G52').setNumberFormat('0');
val(f,'B56','Plan contribution excludes free accounts and fixed costs.');
val(f,'B57','Operating profit excludes founder draw. Owner draw is after illustrative reserves.');
val(f,'B58','Break-even GB excludes free users and fixed costs. Usage above this loses money per paid account.');
val(f,'B59','Review: paid customer mix total');formula(f,'C59',"=SUM('Assumptions'!D31:D32)");f.getRange('C59').setNumberFormat('0.0%');
val(f,'B60','Review: accounts reconcile');formula(f,'C60','=C6-C7-C8');
header(f,63,'Plan economics at selected usage');
f.getRange('B64:G64').values=[['Total GB','Monthly price','Used GB','Storage cost','Other variable costs','Contribution']];
f.getRange('B64:G64').format={wrapText:true,rowHeight:33,font:{bold:true}};
for(let i=0;i<2;i++){
 const r=65+i,j=31+i;
 f.getRange(`B${r}:G${r}`).formulas=[[
 `='Assumptions'!B${j}`,`='Assumptions'!C${j}`,`=B${r}*'Assumptions'!C${33+i}`,
 `=D${r}*(1+'Assumptions'!$C$11)*'Assumptions'!$C$12`,
 `=C${r}*('Assumptions'!$C$13+'Assumptions'!$C$15)+'Assumptions'!$C$14+'Assumptions'!$C$17+'Assumptions'!$C$18`,
 `=C${r}-E${r}-F${r}`
 ]];
}
f.getRange('C65:C66').setNumberFormat(decimal);f.getRange('D65:D66').setNumberFormat('#,##0');f.getRange('E65:G66').setNumberFormat(decimal);
val(market,'B2','Consumer storage price comparison');
val(market,'B3','US dollar monthly billing, checked 29 September 2026. Local prices and taxes vary.');
header(market,5,'Provider and advertised capacity','G');
market.getRange('B6:E14').values=[['Provider / plan','Capacity (GB)','USD / month','Context'],
 ['Harbor0 500 GB',500,10,'Proposed monthly plan'],['Harbor0 1 TB',1000,20,'Proposed monthly plan'],
 ['Google One',2000,9.99,'Shared storage across Drive, Gmail and Photos'],
 ['Apple iCloud+',2000,9.99,'Apple ecosystem; family sharing'],
 ['Dropbox Plus',2000,11.99,'Monthly price; annual billing advertises $9.99/month'],
 ['Microsoft 365 Personal',1000,9.99,'Includes Microsoft apps; $99.99 annual option'],
 ['pCloud Premium',500,4.99,'Monthly subscription'],
 ['pCloud Premium Plus',2000,9.99,'Monthly subscription']];
market.getRange('B6:E6').format.font.bold=true;
market.getRange('B7:B8').format.font.bold=true;
market.getRange('C7:C14').setNumberFormat('#,##0');market.getRange('D7:D14').setNumberFormat('$0.00');
market.getRange('E1:E20').format.columnWidth=55;
market.getRange('F1:F20').format.columnWidth=3;
market.getRange('G1:G20').format.columnWidth=90;
val(market,'G6','Source');
const links=['User proposed price','User proposed price','https://one.google.com/about/plans','https://www.apple.com/icloud/','https://www.dropbox.com/plans?billing=monthly','https://www.microsoft.com/en-us/microsoft-365/onedrive/onedrive-plans-and-pricing','https://www.pcloud.com/cloud-storage-pricing-plans.html?period=month','https://www.pcloud.com/cloud-storage-pricing-plans.html?period=month'];
links.forEach((url,i)=>val(market,`G${7+i}`,url));
val(market,'B17','Capacities and bundles differ. This compares customer prices, not backend object-storage costs.');
f.getRange('F27:F32').conditionalFormats.add('cellIs',{operator:'lessThan',formula:0,format:{font:{color:'#B3261E'}}});
f.getRange('C59').conditionalFormats.add('cellIs',{operator:'notEqual',formula:1,format:{fill:'#FFE4DF',font:{color:'#B3261E',bold:true}}});
f.getRange('C6:C8').setNumberFormat('#,##0');
f.getRange('C6:H22').format.font.color='#182B3A';
f.freezePanes.freezeRows(5);
wb.recalculate();
function n(c){return f.getRange(c).values[0][0];}
const expected={C9:280,C10:1885.4,C11:-1605.4,C21:0,C34:14,C36:340,C39:.53,C40:5.7,C42:-.4054,G65:2.6,G66:10.35};
for(const [c,v] of Object.entries(expected)){if(Math.abs(n(c)-v)>1e-6)throw new Error(`${c}: ${n(c)} != ${v}`);}
const snap=()=>({revenue:n('C9'),cost:n('C10'),profit:n('C11'),draw:n('C21'),accounts:n('H6'),paid:n('H7'),paidContribution:n('C40')});
const results={base:snap()};
for(const p of [.1,.15,.2]){val(a,'C8',p);wb.recalculate();results['paidShare'+p]=snap();if(!Number.isFinite(n('H7')))throw new Error('Viable target calculation failed');}
val(a,'C8',.02);val(a,'C9',2);val(a,'C16',.02);wb.recalculate();results.lowerFreeCost=snap();
val(a,'C9',20);val(a,'C16',.2);val(a,'C33',1);wb.recalculate();if(Math.abs(n('C36')-460)>1e-8)throw new Error('Tier usage edit failed');
val(a,'C33',.6);wb.recalculate();
console.log(JSON.stringify(results));
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!',options:{useRegex:true,maxResults:30},summary:'Final formula error scan'})).ndjson);
for(const [sheetName,range,file] of [['Forecast','B2:H23','forecast-preview.png'],['Forecast','B25:H46','scale-preview.png'],['Assumptions','B5:F26','assumptions-preview.png'],['Assumptions','B29:F34','sources-preview.png'],['Forecast','B49:H66','plans-preview.png'],['Market prices','B2:E17','market-preview.png']]){
 const pic=await wb.render({sheetName,range,scale:1,format:'png'});await fs.writeFile(`${dir}/${file}`,new Uint8Array(await pic.arrayBuffer()));
}
await fs.writeFile(`${dir}/verified-results.json`,JSON.stringify(results,null,2));
await (await SpreadsheetFile.exportXlsx(wb)).save(`${dir}/harbor0-profit-forecast.xlsx`);
