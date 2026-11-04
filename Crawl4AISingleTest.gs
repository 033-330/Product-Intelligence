/* ============================================================
 * Crawl4AISingleTest.gs — 单产品 Crawl4AI 端到端手动测试
 *
 * 用途：不经过表格/任务队列，直接对一个已知官网产品页跑
 *       extractSpecsViaCrawl4AI_()，验证 key、接口、渲染与抽取。
 * 用法：clasp run testCrawl4AIDex
 *       或在 Apps Script 编辑器里直接运行 testCrawl4AIDex
 * 依赖：Script Properties 中配置 CRAWL4AI_API_KEY
 * ============================================================ */

function testCrawl4AIDex() {
  return crawl4aiSingleTest_(
    'Logitech G PRO X SUPERLIGHT 2 DEX',
    'https://www.logitechg.com/en-us/shop/p/pro-x-superlight-2-dex'
  );
}

function crawl4aiSingleTest_(product, url) {
  var out = {
    product: String(product),
    url: String(url),
    started_at: new Date().toISOString()
  };

  try {
    out.crawler = activeSpecCrawler_();
    if (out.crawler !== 'crawl4ai') {
      out.ok = false;
      out.error = '当前规格抓取器是 ' + out.crawler
        + '，请配置 CRAWL4AI_API_KEY（或 SPEC_CRAWLER=crawl4ai）';
      Logger.log(JSON.stringify(out, null, 2));
      return out;
    }

    var parsed = extractSpecsViaCrawl4AI_(out.product, out.url);
    out.ok = parsed.specs.length > 0;
    out.name = parsed.name;
    out.brand = parsed.brand;
    out.model = parsed.model;
    out.spec_count = parsed.specs.length;
    out.specs = parsed.specs.map(function(s) {
      return {
        spec_key: s.spec_key,
        value: s.value,
        unit: s.unit,
        raw_value: s.raw_value
      };
    });
    out.error = out.ok ? '' : '页面未给出可确认规格';
  } catch (e) {
    out.ok = false;
    out.error = String(e && e.message ? e.message : e);
  }

  out.finished_at = new Date().toISOString();
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}