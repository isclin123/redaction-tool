/* 敏感信息识别与打码。
 *
 * 移植自案件管理系统的 redaction_rules.py 和 server.py 里的 preview_redactions / mask_value /
 * add_custom_redactions / apply_redactions，规则与样例保持一致（tests/ 里有逐条对照测试）。
 * 全部在本机运行，不联网。位置用 JavaScript 字符串下标（UTF-16），与 word.js 的文字定位一致。
 */
(function (root) {
  "use strict";

  const SEP = String.raw`[ \t-]?`;
  const FIELD = String.raw` *(?:[:：|] *)?(?:\t *)?`;
  const CREDIT_CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const CREDIT_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  // 只认明确的复姓；普通两字名不能被猜成复姓。
  const COMPOUND_SURNAMES = new Set(`
    欧阳 太史 端木 上官 司马 东方 独孤 南宫 万俟 闻人 夏侯 诸葛 尉迟 公羊
    赫连 澹台 皇甫 宗政 濮阳 公冶 太叔 申屠 公孙 慕容 仲孙 钟离 长孙 宇文
    司徒 鲜于 司空 闾丘 子车 亓官 司寇 巫马 公西 颛孙 壤驷 公良 漆雕 乐正
    宰父 谷梁 拓跋 夹谷 轩辕 令狐 段干 百里 呼延 东郭 南门 羊舌 微生 梁丘
    左丘 东门 西门 第五
  `.split(/\s+/).filter(Boolean));
  const ID_LIKE = new Set(["身份证号", "银行账号", "手机号"]);
  const CUSTOM = "自定义敏感词";

  // 全角转半角：一个字符换一个字符，位置不变。
  function normalizeWidth(text) {
    return text.replace(/[！-～　 ]/g, (char) => {
      const code = char.charCodeAt(0);
      return code >= 0xff01 ? String.fromCharCode(code - 0xfee0) : " ";
    });
  }

  function chars(value) {
    return Array.from(value);
  }

  function maskPersonName(value) {
    const letters = chars(value);
    let surname = letters.length > 2 && COMPOUND_SURNAMES.has(letters.slice(0, 2).join("")) ? 2 : 1;
    // 名字不完整时也不能原样露出。
    surname = Math.min(surname, Math.max(0, letters.length - 1));
    return letters.slice(0, surname).join("") + "*".repeat(letters.length - surname);
  }

  function creditChecksum(value) {
    if (value.length !== 18 || [...value].some((char) => !CREDIT_CHARS.includes(char))) return false;
    let total = 0;
    for (let index = 0; index < 17; index += 1) total += CREDIT_CHARS.indexOf(value[index]) * CREDIT_WEIGHTS[index];
    return value[17] === CREDIT_CHARS[(31 - (total % 31)) % 31];
  }

  function cardChecksum(value) {
    if (value.length < 16 || value.length > 19 || new Set(value).size === 1) return false;
    const digits = [...value].map(Number).reverse();
    const sum = digits.reduce((total, digit, index) => total + (index % 2 ? (digit >= 5 ? digit * 2 - 9 : digit * 2) : digit), 0);
    return sum % 10 === 0;
  }

  function* scan(normalized, label, pattern, flags = "", group = "") {
    const expression = new RegExp(pattern, `g${group ? "d" : ""}${flags}`);
    for (const match of normalized.matchAll(expression)) {
      if (group) {
        const [start, end] = match.indices.groups[group];
        yield [label, start, end];
      } else {
        yield [label, match.index, match.index + match[0].length];
      }
    }
  }

  // 顺序很重要：先出现的类型优先占位（明确字段标签优先于宽泛的格式规则）。
  function* sensitiveSpans(text) {
    const n = normalizeWidth(text);
    yield* scan(n, "银行账号", String.raw`(?:银行账号|银行账户|银行卡号|收款账号|付款账号|开户账号|账号|卡号)` + FIELD
      + String.raw`(?<value>[0-9](?:[ \t-]?[0-9]){7,29})(?![0-9])`, "", "value");
    yield* scan(n, "统一社会信用代码", String.raw`(?:统一社会信用代码|社会信用代码|纳税人识别号)` + FIELD
      + String.raw`(?<value>[A-Z0-9]{15,20})(?![A-Z0-9])`, "i", "value");
    yield* scan(n, "证件号码", String.raw`(?:护照(?:号码|号)?|港澳通行证(?:号码|号)?|台湾通行证(?:号码|号)?)` + FIELD
      + String.raw`(?<value>[A-Z0-9][A-Z0-9-]{4,19})(?![A-Z0-9-])`, "i", "value");
    yield* scan(n, "社交账号", String.raw`(?:微信号|微訊號|QQ号|QQ号码)` + FIELD
      + String.raw`(?<value>[A-Za-z0-9][A-Za-z0-9_-]{4,31})(?![A-Za-z0-9_-])`, "i", "value");
    // 只认带标签、有边界的姓名，不从普通叙述里猜人名。
    yield* scan(n, "姓名", String.raw`(?:联系人|联系姓名|姓名|法定代表人|委托代理人|收件人)` + FIELD
      + String.raw`(?!(?:电话|姓名|地址|未知|不详|待定|待补充|另行通知)(?=[ \t\n\r,，。;；|、]|$))`
      + String.raw`(?<value>[一-鿿]{2,4}(?:·[一-鿿]{2,6})?)(?=[ \t\n\r,，。;；|、]|$)`, "", "value");

    // 身份证优先于长银行账号；不因校验位不对就放过（可能是识别错的字）。
    yield* scan(n, "身份证号", String.raw`(?<![A-Za-z0-9])[1-9][0-9]{5}` + SEP
      + String.raw`(?:19|20)[0-9]{2}` + SEP + String.raw`(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])`
      + SEP + String.raw`[0-9]{3}[0-9Xx](?![A-Za-z0-9])`);
    yield* scan(n, "身份证号", String.raw`(?:身份证(?:号码|号)?|身分證(?:號碼|號)?)` + FIELD
      + String.raw`(?<value>[1-9][0-9]{5}[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3})(?![0-9])`, "", "value");
    yield* scan(n, "手机号", String.raw`(?<![A-Za-z0-9])(?:(?:\+?86|0086)[ \t-]?)?1[3-9][0-9]`
      + SEP + String.raw`[0-9]{4}` + SEP + String.raw`[0-9]{4}(?![A-Za-z0-9])`);
    yield* scan(n, "固定电话", String.raw`(?<![A-Za-z0-9])(?:\(0[0-9]{2,3}\)|0[0-9]{2,3})[ \t-]?`
      + String.raw`[0-9]{7,8}(?:[ \t]*(?:转|分机|ext\.?|-)[ \t]*[0-9]{1,6})?(?![0-9])`, "i");
    yield* scan(n, "邮箱", String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`);
    for (const match of n.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{18}(?![A-Za-z0-9])/g)) {
      if (creditChecksum(match[0].toUpperCase())) yield ["统一社会信用代码", match.index, match.index + 18];
    }
    for (const match of n.matchAll(/(?<![A-Za-z0-9])[0-9]{16,19}(?![A-Za-z0-9])/g)) {
      if (cardChecksum(match[0])) yield ["银行账号", match.index, match.index + match[0].length];
    }
    yield* scan(n, "金额", String.raw`(?:人民币|¥|￥)?[ \t]*[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?[ \t]*(?:亿元|万元|元)`);
    // 明确的公司/地址字段保留标签本身。
    yield* scan(n, "公司名称", String.raw`(?:公司名称|企业名称|单位名称|委托人|甲方|乙方)` + FIELD
      + String.raw`(?<value>[一-鿿A-Za-z0-9()]{2,40}?(?:有限责任公司|股份有限公司|有限公司|事务所|律所))`, "", "value");
    yield* scan(n, "公司名称", String.raw`[一-鿿A-Za-z0-9()]{2,40}?(?:有限责任公司|股份有限公司|有限公司|事务所|律所)`);
    // 有分隔符时允许只到区县的短地址；没有分隔符时必须有街道门牌，避免把「某某法院」当地址。
    const addressLabel = String.raw`(?:注册地址|送达地址|通讯地址|联系地址|住所地|住址|地址)`;
    const addressValue = String.raw`[一-鿿A-Za-z0-9()#-]`;
    yield* scan(n, "地址", addressLabel + String.raw` *(?:[:：|] *|\t *)`
      + String.raw`(?<value>(?=` + addressValue + String.raw`{0,90}(?:省|市|区|县|路|街|巷|号|栋|楼|室|村))`
      + addressValue + String.raw`{3,100})(?=[ \t\n\r,，。;；|]|$)`, "", "value");
    yield* scan(n, "地址", addressLabel + " *"
      + String.raw`(?<value>(?=` + addressValue + String.raw`{0,90}(?:路|街|巷|号|栋|楼|室|村|镇|乡))`
      + addressValue + String.raw`{4,100})(?=[ \t\n\r,，。;；|]|$)`, "", "value");
    yield* scan(n, "地址", String.raw`[一-鿿]{2,20}(?:省|市|区|县)[一-鿿A-Za-z0-9()-]{2,40}`
      + String.raw`(?:号|栋|室|楼|单元)(?:[A-Za-z0-9-]{1,8}(?:号|栋|室|楼|单元))*`);
  }

  function maskValue(label, value) {
    const compact = value.replace(/\s+/g, "");
    if (label === "姓名") return maskPersonName(compact);
    const letters = chars(compact);
    if (ID_LIKE.has(label) && letters.length >= 6) {
      return letters.slice(0, 3).join("") + "*".repeat(Math.max(4, letters.length - 6)) + letters.slice(-3).join("");
    }
    if (label === "邮箱") {
      const at = value.indexOf("@");
      const name = at < 0 ? value : value.slice(0, at);
      const domain = at < 0 ? "" : value.slice(at + 1);
      return `${chars(name).slice(0, 1).join("")}***@${domain}`;
    }
    if (letters.length <= 4) return "*".repeat(letters.length);
    return `${letters.slice(0, 2).join("")}***${letters.slice(-2).join("")}`;
  }

  function applyRedactions(text, matches) {
    const enabled = matches.filter((item) => item.enabled !== false).sort((a, b) => a.start - b.start);
    let output = "";
    let cursor = 0;
    for (const item of enabled) {
      output += text.slice(cursor, item.start) + item.mask;
      cursor = item.end;
    }
    return output + text.slice(cursor);
  }

  function countBy(matches) {
    const counts = {};
    for (const item of matches) counts[item.type] = (counts[item.type] || 0) + 1;
    return counts;
  }

  function overlaps(start, end, occupied) {
    return occupied.some(([usedStart, usedEnd]) => !(end <= usedStart || start >= usedEnd));
  }

  function result(text, matches) {
    matches.sort((a, b) => a.start - b.start);
    return { matches, redactedText: applyRedactions(text, matches), countByType: countBy(matches) };
  }

  function previewRedactions(text, boundaries = []) {
    const matches = [];
    const occupied = [];
    for (let [label, start, end] of sensitiveSpans(text)) {
      // 空白属于版式，不属于敏感内容。
      while (start < end && /\s/.test(text[start])) start += 1;
      while (end > start && /\s/.test(text[end - 1])) end -= 1;
      if (start === end || boundaries.some((boundary) => start <= boundary && boundary < end)) continue;
      if (overlaps(start, end, occupied)) continue;
      const value = text.slice(start, end);
      matches.push({ id: `r${matches.length + 1}`, type: label, value, start, end, mask: maskValue(label, value), enabled: true });
      occupied.push([start, end]);
    }
    return result(text, matches);
  }

  function parseCustomTerms(value) {
    const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
    const terms = [];
    for (const term of raw) {
      const cleaned = String(term).trim();
      if (cleaned && !terms.includes(cleaned)) terms.push(cleaned);
    }
    return terms;
  }

  function addCustomRedactions(text, base, terms) {
    const matches = base.matches.slice();
    const occupied = matches.map((item) => [item.start, item.end]);
    for (const term of terms) {
      for (let start = text.indexOf(term); start >= 0; start = text.indexOf(term, start + term.length)) {
        const end = start + term.length;
        const exact = matches.find((item) => item.start === start && item.end === end);
        if (exact) {
          exact.type = CUSTOM;
          continue;
        }
        if (overlaps(start, end, occupied)) continue;
        matches.push({ id: `r${matches.length + 1}`, type: CUSTOM, value: term, start, end, mask: maskValue(CUSTOM, term), enabled: true });
        occupied.push([start, end]);
      }
    }
    return result(text, matches);
  }

  /** 完整预览：内置规则 + 自定义敏感词 + Word 文档的表格边界、所在位置和复核提示。 */
  function buildPreview(text, { customTerms = [], document = null } = {}) {
    if (!String(text || "").trim()) throw new Error("请先粘贴或导入需要脱敏的文字。");
    const boundaries = document ? document.boundaries : [];
    let preview = previewRedactions(text, boundaries);
    const terms = parseCustomTerms(customTerms);
    if (terms.length) preview = addCustomRedactions(text, preview, terms);
    if (document && preview.matches.some((item) => boundaries.some((boundary) => item.start <= boundary && boundary < item.end))) {
      throw new Error("自定义敏感词不能跨越表格单元格，请按单元格内容分别填写。");
    }
    preview.warnings = document ? document.warnings.slice() : [];
    preview.reviewChecklist = ["核对识别项，并逐项确认需要保留的内容。", "检查自由叙述中的人名、间接身份线索和自定义敏感词。"];
    if (document) {
      preview.reviewChecklist.push("已包含正文、表格、页眉页脚和脚注尾注；导出时清除批注、文档属性及链接目标。");
      for (const item of preview.matches) {
        item.location = (document.sections.find((part) => part.start <= item.start && item.start < part.end) || {}).name || "正文";
      }
    }
    return preview;
  }

  root.RedactionRules = {
    sensitiveSpans, maskPersonName, maskValue, previewRedactions, parseCustomTerms,
    addCustomRedactions, applyRedactions, countBy, buildPreview,
  };
})(typeof window !== "undefined" ? window : globalThis);
