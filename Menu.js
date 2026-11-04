/* Menu.js - 自动挂载菜单 */
function onOpen(e) {
  // 统一由 addTrendMenu / addSmokeMenu 创建，内部已做无 UI 上下文的容错，
  // 避免在 onOpen 里再维护一份菜单列表导致两边不一致。
  addTrendMenu();
  addSmokeMenu();
}

function addTrendMenu() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('趋势分析')
      .addItem('按产品查看趋势（输入 product_id）', 'promptTrendProduct')
      .addItem('按话题查看趋势（输入 topic_id）', 'promptTrendTopic')
      .addToUi();
  } catch (e) {}
}

function addSmokeMenu() {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.createMenu('冒烟测试')
      .addItem('1) 产品实体过滤（纯函数）', 'smoke_productEntity')
      .addItem('【实测】用第14期报告跑完整Pipeline', 'smoke_pipelineFromLogitechReport14')
      .addItem('【实测】从 SmokeInput!A2 跑Pipeline（推荐，支持长文本）', 'smoke_pipelineFromInputSheet')
      .addItem('2) 随机挑1个产品跑 URL 核验', 'smoke_verifyOne')
      .addItem('3) 批量核验（最多5个，仅隔离不删除）', 'smoke_verifyBatch')
      .addItem('4) 耳机规格提取（用真实耳机产品）', 'smoke_extractHeadset')
      .addItem('4.5) Crawl4AI 规格采集（最多3个产品）', 'smoke_crawl4aiSpecs')
      .addItem('5) 验证隔离产品不入队规格', 'smoke_quarantineBlocksTask')
      .addItem('6) 查看隔离/待复核状态', 'smoke_reportStatus')
      .addItem('7) 安装/检查 URL 核验触发器（6小时）', 'smoke_ensureUrlVerifyTrigger')
      .addSeparator()
      .addItem('一键冒烟（推荐）', 'smoke_all')
      .addToUi();
  } catch (e) {}
}
