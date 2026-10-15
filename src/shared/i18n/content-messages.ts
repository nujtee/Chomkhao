/**
 * UI chrome for the public Home, Gallery and History pages (Phase 12). Content itself (titles,
 * texts, images) comes from D1 / R2 — these are only labels, buttons and accessibility texts.
 * `th` is the reference shape; EN and ZH-CN must have the same keys (tested).
 */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

const th = {
  slideshow: {
    region: "ภาพไฮไลต์",
    prev: "ภาพก่อนหน้า",
    next: "ภาพถัดไป",
    pause: "หยุดเลื่อนอัตโนมัติ",
    play: "เลื่อนอัตโนมัติ",
    goTo: "ไปยังภาพที่ {n}",
    position: "ภาพที่ {n} จาก {total}",
  },
  home: {
    accommodations: "ที่พักของเรา",
    gallery: "คลังภาพ",
    history: "เกี่ยวกับเรา",
    food: "อาหาร",
    location: "การเดินทาง",
    contact: "ติดต่อเรา",
    bookNow: "จองเลย",
    viewAll: "ดูทั้งหมด",
    readMore: "อ่านต่อ",
    fromPrice: "{price} / คืน",
    campingPrice: "{price} / ผู้ใหญ่ / คืน",
    openMap: "เปิดแผนที่",
    line: "LINE",
    phone: "โทร",
    email: "อีเมล",
    address: "ที่อยู่",
  },
  gallery: {
    filter: "หมวดหมู่ภาพ",
    all: "ทั้งหมด",
    empty: "ยังไม่มีภาพในคลังภาพ",
    emptyCategory: "ยังไม่มีภาพในหมวดนี้",
    open: "ดูภาพขนาดใหญ่: {title}",
    count: "{n} ภาพ",
    loading: "กำลังโหลดภาพ…",
  },
  lightbox: {
    label: "ดูภาพขนาดใหญ่",
    close: "ปิด",
    prev: "ภาพก่อนหน้า",
    next: "ภาพถัดไป",
    position: "{n} / {total}",
  },
  history: {
    timeline: "เส้นเวลา",
    empty: "เนื้อหาเกี่ยวกับเราจะแสดงที่นี่เมื่อเผยแพร่",
    era: "พ.ศ. {year}",
  },
  food: {
    perPerson: "/ ท่าน",
    perSet: "/ ชุด",
    perItem: "/ รายการ",
    perNight: "/ คืน",
  },
};

export type ContentMessages = Widen<typeof th>;

const en: ContentMessages = {
  slideshow: {
    region: "Highlights",
    prev: "Previous slide",
    next: "Next slide",
    pause: "Pause slideshow",
    play: "Play slideshow",
    goTo: "Go to slide {n}",
    position: "Slide {n} of {total}",
  },
  home: {
    accommodations: "Stay with us",
    gallery: "Gallery",
    history: "Our story",
    food: "Food",
    location: "Getting here",
    contact: "Contact",
    bookNow: "Book now",
    viewAll: "See all",
    readMore: "Read more",
    fromPrice: "{price} / night",
    campingPrice: "{price} / adult / night",
    openMap: "Open map",
    line: "LINE",
    phone: "Phone",
    email: "Email",
    address: "Address",
  },
  gallery: {
    filter: "Photo categories",
    all: "All",
    empty: "No photos in the gallery yet.",
    emptyCategory: "No photos in this category yet.",
    open: "Open photo: {title}",
    count: "{n} photos",
    loading: "Loading photos…",
  },
  lightbox: {
    label: "Photo viewer",
    close: "Close",
    prev: "Previous photo",
    next: "Next photo",
    position: "{n} / {total}",
  },
  history: {
    timeline: "Timeline",
    empty: "Our story will appear here once it has been published.",
    era: "{year}",
  },
  food: {
    perPerson: "/ person",
    perSet: "/ set",
    perItem: "/ item",
    perNight: "/ night",
  },
};

const zhCN: ContentMessages = {
  slideshow: {
    region: "精选图片",
    prev: "上一张",
    next: "下一张",
    pause: "暂停轮播",
    play: "自动轮播",
    goTo: "转到第 {n} 张",
    position: "第 {n} 张，共 {total} 张",
  },
  home: {
    accommodations: "住宿",
    gallery: "相册",
    history: "我们的故事",
    food: "餐饮",
    location: "交通",
    contact: "联系我们",
    bookNow: "立即预订",
    viewAll: "查看全部",
    readMore: "阅读更多",
    fromPrice: "{price} / 晚",
    campingPrice: "{price} / 成人 / 晚",
    openMap: "打开地图",
    line: "LINE",
    phone: "电话",
    email: "邮箱",
    address: "地址",
  },
  gallery: {
    filter: "图片分类",
    all: "全部",
    empty: "相册中还没有图片。",
    emptyCategory: "此分类中还没有图片。",
    open: "查看大图：{title}",
    count: "{n} 张图片",
    loading: "正在加载图片…",
  },
  lightbox: {
    label: "图片查看器",
    close: "关闭",
    prev: "上一张",
    next: "下一张",
    position: "{n} / {total}",
  },
  history: {
    timeline: "时间线",
    empty: "我们的故事发布后将在此显示。",
    era: "{year}",
  },
  food: {
    perPerson: "/ 人",
    perSet: "/ 套",
    perItem: "/ 份",
    perNight: "/ 晚",
  },
};

const DICTIONARIES = { th, en, "zh-CN": zhCN } as const;

export function getContentMessages(code: keyof typeof DICTIONARIES): ContentMessages {
  return DICTIONARIES[code] ?? th;
}

export { th as contentTh, en as contentEn, zhCN as contentZhCN };
