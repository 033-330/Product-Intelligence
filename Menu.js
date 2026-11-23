/* Menu.js - 自动挂载菜单 */
function onOpen(e) {
  // 统一由 addTrendMenu 创建，内部已做无 UI 上下文的容错。
  addTrendMenu();
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
