// Vietnamese chips for the context-aware suggestion row, plus the page
// translation chip that replaced upstream's WebBrain social promotion.
//
// Upstream hardcodes English labels inside buildRecommendedActions(); only the
// promotion pair ever went through t(). Relabelling here by stable action id
// keeps the patch on that file down to four lines — ids survive upstream copy
// edits to the English text, and a chip upstream adds later simply stays in
// English until it is listed below.

import { getLocale } from './i18n.js';

const VI_LABELS = Object.freeze({
  'translate-page': 'Dịch trang này sang tiếng Việt',
  'record-meeting': 'Ghi lại cuộc họp này',
  'github-release': 'Tạo bản phát hành mới',
  'rewrite-focused-draft': 'Viết lại bản nháp đang soạn',
  'draft-reply': 'Soạn thư trả lời',
  'summarize-thread': 'Tóm tắt hội thoại này',
  'find-followups': 'Tìm việc cần theo dõi',
  'research-person': 'Tìm hiểu về người này',
  'draft-wp-post': 'Soạn một bài viết',
  'change-wp-template': 'Đổi giao diện mẫu',
  'like-profile': 'Thích hồ sơ này',
  'summarize-youtube-video': 'Tóm tắt video này',
  'download-media': 'Tải video/ảnh này về',
  'find-coupons': 'Tìm mã giảm giá',
  'fill-profile': 'Điền biểu mẫu bằng thông tin đã lưu',
  'summarize-page': 'Tóm tắt trang này',
  'compare-price': 'So sánh giá với cửa hàng khác',
  'explain-page': 'Giải thích trang này',
});

// Deliberately excludes à á â è é ê ì í ò ó ô ù ú ã õ ý: French, Portuguese,
// Spanish and Italian lean on those, and including them scored fr/pt/es above
// 10% — indistinguishable from Vietnamese. What is left (horn vowels, hook
// above, dot below, and the circumflex/breve/horn+tone stacks) scores 0% on
// every other locale this build ships and 9-16% on real Vietnamese prose.
const VIETNAMESE_LETTER_RE = /[ăđơưảẻỉỏủỷạẹịọụỵấầẩẫậắằẳẵặếềểễệốồổỗộớờởỡợứừửữựĩũỹỳ]/gi;
const ANY_LETTER_RE = /\p{L}/gu;
const VIETNAMESE_SAMPLE_CHARS = 3000;
// An English article naming Việt Nam twenty times still only reaches 1.3%, so
// 4% separates the two with room on both sides. The hit and letter floors stop
// a near-empty page from being classified off one accented word.
const VIETNAMESE_MIN_HITS = 3;
const VIETNAMESE_MIN_LETTERS = 20;
const VIETNAMESE_MIN_RATIO = 0.04;

/**
 * Whether the page already reads as Vietnamese, so offering to translate it
 * into Vietnamese would be noise.
 * @param {Object} pageInfo - Page metadata from get_page_info.
 * @returns {boolean}
 */
export function looksVietnamese(pageInfo = {}) {
  // Pages served as NFD decompose "ệ" into e + two combining marks, which no
  // precomposed character class can match. Recompose before counting.
  const sample = [
    pageInfo.title,
    pageInfo.description,
    String(pageInfo.text || '').slice(0, VIETNAMESE_SAMPLE_CHARS),
  ].filter(Boolean).join(' ').normalize('NFC');
  const hits = (sample.match(VIETNAMESE_LETTER_RE) || []).length;
  const letters = (sample.match(ANY_LETTER_RE) || []).length;
  if (hits < VIETNAMESE_MIN_HITS || letters < VIETNAMESE_MIN_LETTERS) return false;
  return hits / letters >= VIETNAMESE_MIN_RATIO;
}

/**
 * The chip that took the promotion's always-visible first slot: translate the
 * open page into the reader's language. Skipped when the page is already in
 * that language — only detectable for Vietnamese, which is the shipped default
 * and the only locale this build promises the check for.
 * @param {Object} pageInfo - Page metadata from get_page_info.
 * @returns {Object|null} A recommended action, or null when it does not apply.
 */
export function buildTranslatePageAction(pageInfo = {}) {
  if (!pageInfo?.title) return null;
  if (getLocale() === 'vi' && looksVietnamese(pageInfo)) return null;
  return {
    id: 'translate-page',
    label: 'Translate this page into Vietnamese',
    prompt: 'Use read_page first for the current page. Translate its main content into Vietnamese, keeping the original headings, lists, and order. Report the translation in the chat only; never type into or modify the page.',
    runOptions: {
      id: 'translate-page',
      autoExecute: true,
      tool: 'read_page',
      args: { includeChrome: false },
      summary: 'Read the page before translating it into Vietnamese.',
      steps: [
        'Call read_page with includeChrome:false.',
        'Translate the returned page text into Vietnamese, preserving headings, lists, and order.',
        'Answer in the chat only; never type into or modify the page.',
      ],
    },
  };
}

/**
 * Swap English chip labels for Vietnamese ones. Other locales keep whatever
 * upstream produced, which is the English they were already showing.
 * @param {Array<Object>} actions - Actions from buildRecommendedActions.
 * @returns {Array<Object>} The same actions, relabelled when the UI is Vietnamese.
 */
export function localizeRecommendedActions(actions = []) {
  if (getLocale() !== 'vi') return actions;
  return actions.map((action) => {
    const label = VI_LABELS[action?.id];
    return label ? { ...action, label } : action;
  });
}
