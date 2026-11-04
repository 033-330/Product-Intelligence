$path = "C:\Users\Administrator\PI\SmokeTest.js"
$s = Get-Content $path -Raw
$s2 = $s -replace '(?s)function\s+onOpen\s*\([^\)]*\)\s*\{.*?\r?\n\}\s*', ''
$menu = @"
function addSmokeMenu() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('冒烟测试')
    .addItem('1) 产品实体过滤（纯函数）', 'smoke_productEntity')
    .addItem('2) 随机挑1个产品跑 URL 核验', 'smoke_verifyOne')
    .addItem('3) 批量核验（最多5个，仅隔离不删除）', 'smoke_verifyBatch')
    .addItem('4) 耳机规格提取（用真实耳机产品）', 'smoke_extractHeadset')
    .addItem('5) 验证隔离产品不入队规格', 'smoke_quarantineBlocksTask')
    .addItem('6) 查看隔离/待复核状态', 'smoke_reportStatus')
    .addSeparator()
    .addItem('一键冒烟（推荐）', 'smoke_all')
    .addToUi();
}

"@
Set-Content $path -Value ($menu + $s2) -Encoding UTF8
Write-Host "done"
