/* Menu.js - 自动挂载菜单 */
function onOpen() {
  try {
    if (typeof addTrendMenu === 'function') {
      addTrendMenu();
    }
  } catch (e) {
    Logger.log('addTrendMenu failed: ' + e);
  }
}
