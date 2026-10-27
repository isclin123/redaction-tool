/* 敏感信息识别与打码。
 *
 * 起点是案件管理系统的 redaction_rules.py 和 server.py 里的 preview_redactions / mask_value /
 * add_custom_redactions / apply_redactions；之后加强了姓名（法律文书里的身份、叙述提示、表格列、全文同名回填）、
 * 地址和公司名称的边界、车牌号等。tests/run_rules_parity.mjs 保证原规则能遮住的现在都还遮住，
 * tests/quality 用仿真文书评测漏遮和误遮。
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

  // ---- 姓名 ----
  // 法律文书里常见的人员身份。标签后（可带「（出借人）」之类的说明、冒号或「是/为」）紧跟的 2–4 个汉字按姓名处理。
  const ROLES = `
    委托诉讼代理人 委托代理人 诉讼代理人 法定代理人 指定代理人 代理人 辩护人 法定代表人 负责人 经办人
    原告 被告人 被告 第三人 被上诉人 上诉人 再审申请人 被申请人 申请执行人 被执行人 申请人 起诉人 具状人 答辩人
    委托人 受托人 当事人 证人 见证人 出借人 借款人 欠款人 贷款人 担保人 保证人 抵押人 出质人 债权人 债务人
    出租人 承租人 出卖人 买受人 发包人 承包人 转让人 受让人 赠与人 受赠人 立遗嘱人 遗嘱人 被继承人 继承人 监护人
    投保人 被保险人 受益人 收款人 付款人 持卡人 紧急联系人 联系人 收件人 寄件人 签收人 代收人 受送达人 被传唤人
    说明人 陈述人 声明人 承诺人 立据人 提交人 被害人 受害人 犯罪嫌疑人 嫌疑人 报案人 举报人 控告人
    被询问人 询问人 被讯问人 被调查人 记录人 驾驶人 驾驶员 劳动者 患者 家属 股东 主治医师 医师
    曾用名 别名 化名 绰号 又名 甲方 乙方 丙方 丁方 男方 女方 户名 开户名 账户名 户主 联系姓名 姓名 律师
  `.split(/\s+/).filter(Boolean).join("|");
  const ROLE_SET = new Set(ROLES.split("|"));
  // 不带冒号直接跟人名的写法（「原告王建国」「被告人宋建军」「辩护人罗佳」）只出现在诉讼、刑事和个人身份上；
  // 合同里的「甲方」「承包人」后面直接跟的是动词（「甲方迟延」「发包人付款后」），必须有冒号才认。
  const NO_COLON_ROLES = new Set(`
    原告 被告人 被告 第三人 上诉人 被上诉人 申请人 被申请人 再审申请人 申请执行人 被执行人 起诉人 答辩人
    辩护人 代理人 委托代理人 委托诉讼代理人 诉讼代理人 法定代理人 法定代表人 被害人 受害人 犯罪嫌疑人 嫌疑人
    证人 见证人 当事人 曾用名 别名 化名 绰号 又名 借款人 出借人 欠款人 收款人 付款人 股东 家属 患者
    联系人 紧急联系人 驾驶人 立遗嘱人 被继承人 被询问人 被传唤人 受送达人 代收人
  `.split(/\s+/).filter(Boolean));
  // 首字是常见姓、但其实是常用词的开头（「付款后」「施工图」「迟延」）。
  const NOT_NAME_PREFIX = /^(?:付款|付清|施工|施行|迟延|迟到|肖像|董事|费用|费率|涂料|施肥|余额|余款|金额|程序|许可|曾经|陆续|顾客|范围|严重|严格|周期|周年|周边|高额|高度|黄金|林地|胡同|郑重|何时|何种|何况|马上|毛利|蓝色|夏季|童年|季度|纪律|罗列|祝贺|段落|颜色|雷同|方案|方式|方面|向下|向上|于是|于此)/;
  // 叙述里提示「后面是人名」的词：只在姓氏常见、后面是标点或常见虚词时才算。
  const PROSE_CUES = `
    本人叫 本人 我叫 我是 名叫 叫做 名字叫 姓名是 我和 我与 我跟 你和 你与 你跟 他和 他与 他跟 她和 她与 她跟 致 尊敬的 借到 欠到 收到 遇到 碰到 找到 看到 听到
    通知 交给 转给 付给 之妻 之夫 妻子 丈夫 老婆 老公 爱人 配偶 父亲 母亲 儿子 女儿 一子 一女 之子 之女
    婚生子 婚生女 长子 次子 长女 次女 哥哥 姐姐 弟弟 妹妹 朋友 同事 邻居
  `.split(/\s+/).filter(Boolean).join("|");
  const COLUMN_SURNAMES = new Set([..."方石任于白江雷龙史武温康华安常向文"]);
  const SURNAMES = new Set([..."王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡余杜叶程苏魏吕丁沈姚卢姜崔钟谭陆汪范金廖贾夏韦付邹孟熊秦邱尹薛闫段侯陶黎贺顾毛郝龚邵钱严覃戴莫孔汤施樊葛邢乔伍庞颜倪庄聂鲁岳翟殷詹欧耿俞柳祝舒阮柯纪梅童凌毕季裴霍涂苗谷盛翁冉骆蓝辛靳柴蒙鲍喻祁蒲滕屈饶牟艾尤穆卓缪芦麦褚娄窦戚岑费卜晏瞿桂佟臧闵苟邬卞姬仇栾隋刁沙荣巫寇桑郎甄丛虞敖巩佘迟邝谌奚冼蔺阚屠帅郜粟楚鄢"]);
  // 紧跟在身份后面、首字又像姓的常见词，以及表头、民族、学历等，不当人名。
  const NOT_NAMES = new Set(`
    电话 姓名 地址 未知 不详 待定 待补充 另行通知 本人 双方 对方 一方 各方 他人 暂无 同上 见上 如下 签字 签名 盖章 日期
    法人 单位 公司 个人 负责人 代理人 律师 法官 总经理 经理 董事长 主任 会计 出纳 老板 股东 员工 职员 业主 房东 租客
    甲方 乙方 原告 被告 委托人 受托人 当事人 第三人 联系人 身份证 手机 微信 陈述 陈列 高度 周年 周期 周边 程序 程度
    费用 金额 范围 严重 严格 余额 余款 付款 付清 许可 曾经 陆续 顾客 祝贺 毕业 童年 凌晨 季度 纪律 董事 罗列 孙子
    马上 高于 黄金 林地 胡同 郑重 何时 何种 何况 何处 苏醒 杜绝 叶片 夏季 段落 黎明 钱款 钱财 莫非 施工 施行 颜色
    性别 年龄 民族 籍贯 职务 职业 学历 备注 序号 关系 初中 高中 小学 大学 本科 专科 硕士 博士 无业 农民 工人 干部 退休
  `.split(/\s+/).filter(Boolean));
  // 字段标签里有这些词时，冒号后面不是人名（「代理权限：特别授权」「传唤事由：开庭」）。
  const NOT_NAME_FIELD = /日期|时间|地点|地址|住址|住所|电话|手机|金额|案由|罪名|性别|民族|籍贯|职务|职业|学历|文化|结论|意见|结果|状态|摘要|备注|开户|银行|户籍|出生|权限|事由|标的|币种|用途|期限|方式|类型|事项|名称|单位|公司|案号|编号|号码|账号|邮箱|处所|法庭|法院|罚款|处罚|事实|决定|理由|依据|请求|内容|标题|主题|项目|产品|规格|型号|数量|价/;
  const NAME_HARD_END = String.raw`[ \t\n\r,，。;；|、()（）:：]`;
  const NAME = String.raw`(?<value>[一-鿿]{2,4}(?:·[一-鿿]{2,6})?)`;
  const NAME_ENDINGS = String.raw`${NAME_HARD_END}|先生|女士|同志|签名|签字|到庭|归还|的|与|和|及|向|因|于|在|将|已|为|是|系|称|说|等|从|把|被|给|对|让|跟|由|这|那|也|都|就|又|还|刚|才|家|$`;
  const NAME_END = String.raw`(?=(?<end>${NAME_ENDINGS}))`;
  const ENDING_AT = new RegExp(String.raw`^(?:${NAME_ENDINGS})`);
  const ROLE_NAME = new RegExp(String.raw`(?:${ROLES})(?:\([^)\n]{1,12}\))?(?<sep>[ \t]*[:|][ \t]*|\t[ \t]*)?(?<link>是|为|叫|名叫|名为)?` + NAME + NAME_END, "gd");
  const ROLE_GROUP = new RegExp(String.raw`^(?:${ROLES})`);
  const FIELD_NAME = new RegExp(String.raw`(?<=^|[\s,，。;；、(])(?<field>[一-鿿]{2,8})(?:\([^)\n]{1,8}\))?[ \t]*:[ \t]*` + NAME + String.raw`(?=${NAME_HARD_END}|$)`, "gd");
  const PROSE_NAME = new RegExp(String.raw`(?:${PROSE_CUES})(?::[ \t]*|\(|[ \t]*)` + NAME + NAME_END, "gd");
  const SELF_NAME = new RegExp(String.raw`(?:我|本人)\(` + NAME + String.raw`(?=\))`, "gd");
  const SPEAKER = new RegExp(String.raw`(?<=^|\n)` + NAME + String.raw`[ \t]*:`, "gd");
  const LIST_NEXT = new RegExp(String.raw`^(?:、|[ \t]+)` + NAME + String.raw`(?=[、\s,，。;；]|$)`, "d");
  const STRONG_END = /^(?:[ \t\n\r,，。;；|、()（）:：]|先生|女士|同志|签名|签字|到庭)?$/;

  /** strong：带冒号的字段（「原告：王建国，」）；weak：叙述里的（「被告李秀英因…」「他妻子陈芳的」），要求常见姓氏。 */
  function isLikelyName(value, strong, minLength = 2, column = false) {
    if (/[某*＊×xX]/.test(value) || NOT_NAMES.has(value) || ROLE_SET.has(value) || NOT_NAME_PREFIX.test(value)) return false;
    // 机构、职务、身份（「承包人」「丙方」「工会主席」）和表头字段都不是人名。
    if (/(?:公司|单位|银行|法院|医院|学校|政府|委员会|局|所|部|处|中心|集团|协会|分行|支行|大学|学院|族|人|员|方|行|会|号|主席|主任|代表|经理|会长|秘书|董事|监事|委员|部门)$/.test(value)) return false;
    if (/账号|户名|金额|日期|摘要|号码|名称|地址|址|电话|证号|编号|类型|时间|方式|地点|编码|份额|样式|职称|国籍|签名|签字|费用|阶段|人数/.test(value)) return false;
    // 「第五」虽是复姓，在文书里几乎都是「第五条」「第五部分」。
    const compound = COMPOUND_SURNAMES.has(value.slice(0, 2)) && !value.startsWith("第");
    if (!compound && /^[本该其贵此各每全无未不已均另非如按经现第]/.test(value)) return false;
    if (strong) return true;
    const plain = value.split("·")[0];
    if (!compound && plain.length < minLength) return false;
    return compound ? plain.length <= 4 : plain.length <= 3 && (SURNAMES.has(plain[0]) || (column && COLUMN_SURNAMES.has(plain[0])));
  }

  /** 「出席股东：赵一鸣、钱小东、孙立平」「见证人：沈立新、葛春燕」：接着读用顿号或空格隔开的名字。 */
  function* followingNames(n, end, strong) {
    for (;;) {
      const next = LIST_NEXT.exec(n.slice(end));
      const spaced = !next || !next[0].startsWith("、");
      if (!next || /^[:：]/.test(n.slice(end + next.indices.groups.value[1])) || !isLikelyName(next.groups.value, strong && !spaced)) return;
      const [start, stop] = next.indices.groups.value;
      yield ["姓名", end + start, end + stop];
      end += stop;
    }
  }

  /**
   * 正则先取最长的候选（「郝思琪由被告」里先取到「郝思琪由」），不像人名时退回更短、后面也是合法结尾的候选。
   * 返回 [开始, 结束, 是否强] 或 null。
   */
  function pickName(n, start, value, strongContext, minLength = 2) {
    for (let length = value.length; length >= 2; length -= 1) {
      const candidate = value.slice(0, length);
      const ending = ENDING_AT.exec(n.slice(start + length));
      if (length < value.length && !ending) continue;
      // 后面紧跟冒号的是下一个字段的标签（空白模板里「出卖人：　买受人：」），不是填写的人名。
      if (/^(?:\([^)\n]{0,12}\))?[ \t]*[:：]/.test(n.slice(start + length))) continue;
      const hard = !ending || STRONG_END.test(ending[0]);
      const strong = strongContext && hard;
      // 后面是标点时两个字的名字也认；后面是「因」「的」之类的虚词时才要求更长。
      if (isLikelyName(candidate, strong, hard ? 2 : minLength)) return [start, start + length, strong];
    }
    return null;
  }

  function* nameSpans(n) {
    for (const match of n.matchAll(ROLE_NAME)) {
      const { value, sep, link } = match.groups;
      if (!sep && !NO_COLON_ROLES.has(ROLE_GROUP.exec(match[0])[0])) continue;
      const colon = Boolean(sep) && /[:|]/.test(sep);
      const picked = pickName(n, match.indices.groups.value[0], value, colon && !link, sep ? 2 : 3);
      if (!picked) continue;
      yield ["姓名", picked[0], picked[1]];
      yield* followingNames(n, picked[1], picked[2]);
    }
    for (const match of n.matchAll(FIELD_NAME)) {
      if (NOT_NAME_FIELD.test(match.groups.field) || !isLikelyName(match.groups.value, false)) continue;
      yield ["姓名", ...match.indices.groups.value];
      yield* followingNames(n, match.indices.groups.value[1], false);
    }
    for (const expression of [PROSE_NAME, SELF_NAME]) {
      for (const match of n.matchAll(expression)) {
        const picked = pickName(n, match.indices.groups.value[0], match.groups.value, false);
        if (picked) yield ["姓名", picked[0], picked[1]];
      }
    }
    // 聊天记录、笔录的行首说话人「周晓雯：」：只认三个字以上的（两个字的多半是「施肥：」这样的字段名）。
    for (const match of n.matchAll(SPEAKER)) {
      if (isLikelyName(match.groups.value, false, 3)) yield ["姓名", ...match.indices.groups.value];
    }
  }

  // ---- 表格：按表头认出姓名列、账号列（「对方户名」「对方账号」）----
  const NAME_COLUMN = /^(?:姓名|名字|户名|对方户名|开户名|账户名|收款人|付款人|联系人|当事人|收件人|寄件人|员工姓名|客户姓名|借款人|出借人)$/;
  const ACCOUNT_COLUMN = /^(?:账号|卡号|对方账号|银行账号|银行卡号|收款账号|付款账号|账户)$/;

  function* tableSpans(n) {
    let header = null;
    let offset = 0;
    for (const line of n.split("\n")) {
      const cells = [];
      let cursor = offset;
      for (const cell of line.split("\t")) {
        cells.push({ value: cell.trim(), start: cursor + cell.length - cell.trimStart().length });
        cursor += cell.length + 1;
      }
      offset += line.length + 1;
      if (cells.length < 2) {
        header = null;
        continue;
      }
      const names = cells.flatMap((cell, index) => (NAME_COLUMN.test(cell.value) ? [index] : []));
      const accounts = cells.flatMap((cell, index) => (ACCOUNT_COLUMN.test(cell.value) ? [index] : []));
      if (names.length || accounts.length) {
        header = { names, accounts, count: cells.length };
        continue;
      }
      if (!header || cells.length !== header.count) continue;
      for (const index of header.names) {
        const { value, start } = cells[index];
        if (/^[一-鿿]{2,4}(?:·[一-鿿]{2,6})?$/.test(value) && isLikelyName(value, false, 2, true)) yield ["姓名", start, start + value.length];
      }
      for (const index of header.accounts) {
        const { value, start } = cells[index];
        if (/^[0-9](?:[ -]?[0-9]){7,29}$/.test(value)) yield ["银行账号", start, start + value.length];
      }
    }
  }

  // ---- 地址、公司名称的边界 ----
  // 地址前面常带「住」「现住」「他住在」「位于」，这些不属于地址；法院名称、案号不是地址。
  const ADDRESS_LEAD = /^(.*(?:住在|住于|居住在|居住于|位于|坐落于|坐落在|家住|现住|所在地|住|在|于|至|到|地|手机|电话|账号|号码|邮箱|微信|姓名|证件|账户|卡号|银行|责任|条款|规定|事项))(?=.{2,}?(?:省|市|区|县))/;
  const NOT_ADDRESS = /法院|检察院|仲裁委|公安局|派出所|司法局|人民政府|号码|证件|姓名|手机|账号|信息|签名|意见|余额|单位|类型|[0-9〇零一二三四五六七八九]{2,4}年|民初|民终|刑初|刑终|行初|行终|执[0-9]|执字/;
  // 公司名称前常连着「原告…与被告」「本所接受」等叙述，切到最后一个连接词后面（剩下的名称至少 4 个字才切）。
  // 「律师」是「××律师事务所」名称的一部分，不当叙述里的身份词。
  const COMPANY_LEAD = new RegExp(String.raw`(?:${ROLES.split("|").filter((role) => role !== "律师").join("|")}|接受|委托|代表|聘请|处理|属于|可以|与|诉|向|由|对|就|系|为|是|的|将|在|及|和|同|跟|给)`, "g");
  const COMPANY_SUFFIX = /(?:有限责任公司|股份有限公司|有限公司|事务所|律所)$/;

  function refineSpan(n, label, start, end) {
    let value = n.slice(start, end);
    if (label === "地址") {
      const lead = ADDRESS_LEAD.exec(value);
      if (lead) start += lead[1].length;
      if (NOT_ADDRESS.test(n.slice(start, end))) return null;
    } else if (label === "公司名称") {
      const suffix = COMPANY_SUFFIX.exec(value);
      const body = suffix ? value.slice(0, suffix.index) : value;
      let cut = 0;
      let last = null;
      for (const marker of body.matchAll(COMPANY_LEAD)) {
        last = marker;
        if (body.length - (marker.index + marker[0].length) >= 4) cut = marker.index + marker[0].length;
      }
      // 最后一个叙述词后面剩不到 4 个字（「处理委托事务所」「房屋属于有限责任公司」）：是叙述，不是公司名。
      // 「和」「与」等也会出现在真实名称里（「北京和信达有限公司」），不按这条处理。
      if (last && last.index + last[0].length > cut && !/^[和与及同跟给]$/.test(last[0])) return null;
      // 名称本身不足 4 个字的是通称（「会计师事务所」「律师事务所」）。
      if (body.length - cut < 4) return null;
      start += cut;
    }
    return [label, start, end];
  }

  // 顺序很重要：先出现的类型优先占位（明确字段标签优先于宽泛的格式规则）。
  function* sensitiveSpans(text) {
    const n = normalizeWidth(text);
    for (const span of rawSpans(n)) {
      const refined = refineSpan(n, ...span);
      if (refined) yield refined;
    }
  }

  function* rawSpans(n) {
    yield* scan(n, "银行账号", String.raw`(?:银行账号|银行账户|银行卡号|收款账号|付款账号|开户账号|账号|卡号)` + FIELD
      + String.raw`(?<value>[0-9](?:[ \t-]?[0-9]){7,29})(?![0-9])`, "", "value");
    yield* scan(n, "统一社会信用代码", String.raw`(?:统一社会信用代码|社会信用代码|纳税人识别号)` + FIELD
      + String.raw`(?<value>[A-Z0-9]{15,20})(?![A-Z0-9])`, "i", "value");
    yield* scan(n, "证件号码", String.raw`(?:护照(?:号码|号)?|港澳通行证(?:号码|号)?|台湾通行证(?:号码|号)?|律师执业证号|执业证号|执业证编号|驾驶证(?:号码|号)?|社保卡号|医保卡号|社会保障号码?)` + FIELD
      + String.raw`(?<value>[A-Z0-9][A-Z0-9-]{4,19})(?![A-Z0-9-])`, "i", "value");
    yield* scan(n, "社交账号", String.raw`(?:微信号|微訊號|QQ号|QQ号码)` + FIELD
      + String.raw`(?<value>[A-Za-z0-9][A-Za-z0-9_-]{4,31})(?![A-Za-z0-9_-])`, "i", "value");
    yield* tableSpans(n);
    yield* nameSpans(n);

    // 身份证优先于长银行账号；不因校验位不对就放过（可能是识别错的字）。
    yield* scan(n, "身份证号", String.raw`(?<![A-Za-z0-9])[1-9][0-9]{5}` + SEP
      + String.raw`(?:19|20)[0-9]{2}` + SEP + String.raw`(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])`
      + SEP + String.raw`[0-9]{3}[0-9Xx](?![A-Za-z0-9])`);
    yield* scan(n, "身份证号", String.raw`(?:身份证(?:号码|号)?|身分證(?:號碼|號)?)` + FIELD
      + String.raw`(?<value>[1-9][0-9]{5}[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3})(?![0-9])`, "", "value");
    yield* scan(n, "手机号", String.raw`(?<![A-Za-z0-9])(?:(?:\+?86|0086)[ \t-]?)?1[3-9][0-9]`
      + SEP + String.raw`[0-9]{4}` + SEP + String.raw`[0-9]{4}(?![A-Za-z0-9])`);
    // 区号必须有；号码中间允许一个空格或横线（「(0755)8888 1234」）。
    yield* scan(n, "固定电话", String.raw`(?<![A-Za-z0-9])(?:\(0[1-9][0-9]{1,2}\)|0[1-9][0-9]{1,2})[ \t-]?`
      + String.raw`[0-9]{3,4}[ \t-]?[0-9]{4}(?:[ \t]*(?:转|分机|ext\.?|-)[ \t]*[0-9]{1,6})?(?![0-9])`, "i");
    yield* scan(n, "邮箱", String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`);
    yield* scan(n, "车牌号", String.raw`(?<![A-Za-z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z][·•.\- ]?[A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳](?![A-Za-z0-9])`);
    for (const match of n.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{18}(?![A-Za-z0-9])/g)) {
      if (creditChecksum(match[0].toUpperCase())) yield ["统一社会信用代码", match.index, match.index + 18];
    }
    // 没有标签的银行卡号：连写或按 4 位分组书写，都要通过卡号校验。
    for (const match of n.matchAll(/(?<![A-Za-z0-9])(?:[0-9]{16,19}|[0-9]{4}(?:[ -][0-9]{4}){3}(?:[ -]?[0-9]{1,3})?)(?![A-Za-z0-9])/g)) {
      if (cardChecksum(match[0].replace(/[ -]/g, ""))) yield ["银行账号", match.index, match.index + match[0].length];
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
    // 门牌必须带数字（「88号」「501室」），避免「公共会议室」「房屋所在楼」；门牌之后常接楼栋、园区名（「1268号天府软件园E区」），一并算进地址。
    yield* scan(n, "地址", String.raw`[一-鿿]{2,20}(?:省|市|区|县)(?!域|场|民|长|委|级|内|外|间|别|政|值|面|划|属|的)[一-鿿A-Za-z0-9()-]{2,40}`
      + String.raw`(?:[0-9一二三四五六七八九十百零〇]+[A-Za-z]?(?:号楼|号院|号|栋|幢|室|楼|单元))(?:[一-鿿A-Za-z0-9-]{1,15}?(?:(?<![账编型卡信字机证照别码])号|栋|幢|座|室|楼|层|单元|区|园|苑|舍|大厦|中心|广场|花园|公寓|大学|学院|校区|医院|酒店|宾馆))*(?:[0-9]{1,4}[A-Za-z]?(?![A-Za-z0-9]))?`);
  }

  function maskValue(label, value) {
    const compact = value.replace(/\s+/g, "");
    if (label === "姓名") return maskPersonName(compact);
    const letters = chars(compact);
    if (ID_LIKE.has(label) && letters.length >= 6) {
      return letters.slice(0, 3).join("") + "*".repeat(Math.max(4, letters.length - 6)) + letters.slice(-3).join("");
    }
    if (label === "车牌号") return letters.slice(0, 2).join("") + "*".repeat(Math.max(0, letters.length - 2));
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
    // 认出的姓名在全文其它地方出现时一并脱敏（「原告：王建国，」之后的「原告王建国借款」「王建国身份证复印件」）。
    const names = [...new Set(matches.filter((item) => item.type === "姓名").map((item) => item.value))].sort((a, b) => b.length - a.length);
    for (const name of names) {
      for (let start = text.indexOf(name); start >= 0; start = text.indexOf(name, start + name.length)) {
        const end = start + name.length;
        if (overlaps(start, end, occupied) || boundaries.some((boundary) => start <= boundary && boundary < end)) continue;
        matches.push({ id: `r${matches.length + 1}`, type: "姓名", value: name, start, end, mask: maskValue("姓名", name), enabled: true });
        occupied.push([start, end]);
      }
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
    let matches = base.matches.slice();
    let serial = matches.length;
    for (const term of terms) {
      for (let start = text.indexOf(term); start >= 0; start = text.indexOf(term, start + term.length)) {
        const end = start + term.length;
        const exact = matches.find((item) => item.start === start && item.end === end);
        if (exact) {
          exact.type = CUSTOM;
          continue;
        }
        // 自己填的词要整段遮住：已被某个识别项整个盖住的不重复加；和识别项交叉的，合并成一段一起遮。
        const touching = matches.filter((item) => !(end <= item.start || start >= item.end));
        if (touching.some((item) => item.start <= start && item.end >= end)) continue;
        const from = Math.min(start, ...touching.map((item) => item.start));
        const to = Math.max(end, ...touching.map((item) => item.end));
        const value = text.slice(from, to);
        matches = matches.filter((item) => !touching.includes(item));
        matches.push({ id: `r${(serial += 1)}`, type: CUSTOM, value, start: from, end: to, mask: maskValue(CUSTOM, value), enabled: true });
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
