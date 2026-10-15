/**
 * UI chrome strings only (navigation, buttons, accessibility labels, empty states).
 * Business content (site name, logos, page content, prices, inventory) is NOT here —
 * it comes from D1/R2 via the API.
 *
 * Every locale must implement this interface, so a missing key is a type error.
 */
export interface Messages {
  nav: {
    home: string;
    gallery: string;
    booking: string;
    history: string;
  };
  header: {
    mainNavigation: string;
    openMenu: string;
    closeMenu: string;
    languageSwitcher: string;
    homeLink: string;
  };
  footer: {
    navigation: string;
    languages: string;
    rights: string;
    contact: string;
    phone: string;
    email: string;
    line: string;
    map: string;
    privacy: string;
    cookieSettings: string;
  };
  common: {
    skipToContent: string;
    loading: string;
    contentPending: string;
    loadError: string;
    retry: string;
    close: string;
    themePreview: string;
    exitPreview: string;
    lineChat: string;
  };
  accommodation: {
    houses: string;
    vipTents: string;
    camping: string;
    perNight: string;
    perAdultPerNight: string;
    childrenFree: string;
    upToGuests: string;
    amenities: string;
    viewDetails: string;
    available: string;
    unavailable: string;
    tooManyGuests: string;
    tentsRemaining: string;
    campingFull: string;
    checkIn: string;
    checkOut: string;
    guests: string;
    tents: string;
    search: string;
    searching: string;
    nights: string;
    chooseDates: string;
    backToBooking: string;
    noAccommodation: string;
    photos: string;
    checkAvailability: string;
    campingDisabled: string;
    errors: Record<"IN_THE_PAST" | "MUST_BE_AFTER_CHECK_IN" | "STAY_TOO_LONG" | "TOO_FAR_AHEAD" | "INVALID_DATE", string>;
  };
  pages: {
    home: { title: string };
    accommodation: { title: string };
    bookingLookup: { title: string };
    gallery: { title: string };
    booking: { title: string };
    history: { title: string };
    privacy: { title: string };
    notFound: { title: string; body: string; backHome: string };
  };
}

export const th: Messages = {
  nav: {
    home: "หน้าหลัก",
    gallery: "คลังภาพ",
    booking: "จองที่พัก",
    history: "เกี่ยวกับเรา",
  },
  header: {
    mainNavigation: "เมนูหลัก",
    openMenu: "เปิดเมนู",
    closeMenu: "ปิดเมนู",
    languageSwitcher: "เลือกภาษา",
    homeLink: "กลับหน้าแรก",
  },
  footer: {
    navigation: "เมนูท้ายเว็บไซต์",
    languages: "ภาษา",
    rights: "สงวนลิขสิทธิ์",
    contact: "ติดต่อเรา",
    phone: "โทร",
    email: "อีเมล",
    line: "LINE",
    map: "แผนที่",
    privacy: "นโยบายความเป็นส่วนตัว",
    cookieSettings: "ตั้งค่าคุกกี้",
  },
  common: {
    skipToContent: "ข้ามไปยังเนื้อหาหลัก",
    loading: "กำลังโหลด…",
    contentPending: "เนื้อหาส่วนนี้จะแสดงเมื่อผู้ดูแลระบบเผยแพร่ข้อมูล",
    loadError: "ไม่สามารถโหลดข้อมูลได้ในขณะนี้",
    retry: "ลองใหม่",
    close: "ปิด",
    themePreview: "กำลังดูตัวอย่างธีมฉบับร่าง (เห็นเฉพาะผู้ดูแล)",
    exitPreview: "ออกจากโหมดตัวอย่าง",
    lineChat: "แชตกับเราทาง LINE",
  },
  accommodation: {
    houses: "บ้านพัก",
    vipTents: "VIP Tent",
    camping: "นำเต็นท์มาเอง",
    perNight: "/ คืน",
    perAdultPerNight: "/ ผู้ใหญ่ / คืน",
    childrenFree: "เด็กอายุต่ำกว่า {age} ปี พักฟรี",
    upToGuests: "รองรับสูงสุด {n} ท่าน",
    amenities: "สิ่งอำนวยความสะดวก",
    viewDetails: "ดูรายละเอียด",
    available: "ว่าง",
    unavailable: "ไม่ว่าง",
    tooManyGuests: "จำนวนผู้เข้าพักเกินความจุ",
    tentsRemaining: "เหลือพื้นที่ {n} เต็นท์",
    campingFull: "พื้นที่กางเต็นท์เต็ม",
    checkIn: "เช็คอิน",
    checkOut: "เช็คเอาท์",
    guests: "ผู้เข้าพัก",
    tents: "จำนวนเต็นท์",
    search: "ตรวจสอบห้องว่าง",
    searching: "กำลังตรวจสอบ…",
    nights: "{n} คืน",
    chooseDates: "เลือกวันเข้าพักเพื่อดูที่พักที่ว่าง",
    backToBooking: "กลับไปหน้าจองที่พัก",
    noAccommodation: "ยังไม่มีที่พักที่เปิดให้จอง",
    photos: "รูปภาพ",
    checkAvailability: "ตรวจสอบวันว่าง",
    campingDisabled: "ปิดรับการกางเต็นท์ชั่วคราว",
    errors: {
      IN_THE_PAST: "วันเช็คอินต้องไม่เป็นวันที่ผ่านมาแล้ว",
      MUST_BE_AFTER_CHECK_IN: "วันเช็คเอาท์ต้องอยู่หลังวันเช็คอิน",
      STAY_TOO_LONG: "จองได้สูงสุด 30 คืนต่อครั้ง",
      TOO_FAR_AHEAD: "จองล่วงหน้าได้ไม่เกิน 1 ปี",
      INVALID_DATE: "วันที่ไม่ถูกต้อง",
    },
  },
  pages: {
    home: { title: "หน้าแรก" },
    accommodation: { title: "ที่พัก" },
    bookingLookup: { title: "ตรวจสอบการจอง" },
    gallery: { title: "คลังภาพ" },
    booking: { title: "จองที่พัก" },
    history: { title: "เกี่ยวกับเรา" },
    privacy: { title: "นโยบายความเป็นส่วนตัว" },
    notFound: {
      title: "ไม่พบหน้าที่ต้องการ",
      body: "หน้าที่คุณค้นหาอาจถูกย้ายหรือไม่มีอยู่",
      backHome: "กลับหน้าแรก",
    },
  },
};

export const en: Messages = {
  nav: {
    home: "Home",
    gallery: "Gallery",
    booking: "Booking",
    history: "History",
  },
  header: {
    mainNavigation: "Main navigation",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    languageSwitcher: "Choose language",
    homeLink: "Go to home page",
  },
  footer: {
    navigation: "Footer navigation",
    languages: "Languages",
    rights: "All rights reserved",
    contact: "Contact",
    phone: "Phone",
    email: "Email",
    line: "LINE",
    map: "Map",
    privacy: "Privacy policy",
    cookieSettings: "Cookie settings",
  },
  common: {
    skipToContent: "Skip to main content",
    loading: "Loading…",
    contentPending: "This section will appear once it has been published.",
    loadError: "We couldn't load this right now.",
    retry: "Try again",
    close: "Close",
    themePreview: "Previewing the draft theme (admins only)",
    exitPreview: "Exit preview",
    lineChat: "Chat with us on LINE",
  },
  accommodation: {
    houses: "Houses",
    vipTents: "VIP Tents",
    camping: "Bring your own tent",
    perNight: "/ night",
    perAdultPerNight: "/ adult / night",
    childrenFree: "Children under {age} stay free",
    upToGuests: "Up to {n} guests",
    amenities: "Amenities",
    viewDetails: "View details",
    available: "Available",
    unavailable: "Not available",
    tooManyGuests: "Too many guests for this unit",
    tentsRemaining: "Space for {n} more tents",
    campingFull: "Camping area is full",
    checkIn: "Check-in",
    checkOut: "Check-out",
    guests: "Guests",
    tents: "Tents",
    search: "Check availability",
    searching: "Checking…",
    nights: "{n} nights",
    chooseDates: "Choose your dates to see what's available",
    backToBooking: "Back to booking",
    noAccommodation: "No accommodation is open for booking yet",
    photos: "Photos",
    checkAvailability: "Check dates",
    campingDisabled: "Camping is temporarily closed",
    errors: {
      IN_THE_PAST: "Check-in can't be in the past",
      MUST_BE_AFTER_CHECK_IN: "Check-out must be after check-in",
      STAY_TOO_LONG: "Stays are limited to 30 nights",
      TOO_FAR_AHEAD: "You can book up to one year ahead",
      INVALID_DATE: "Invalid date",
    },
  },
  pages: {
    home: { title: "Home" },
    accommodation: { title: "Accommodation" },
    bookingLookup: { title: "Check your booking" },
    gallery: { title: "Gallery" },
    booking: { title: "Booking" },
    history: { title: "History" },
    privacy: { title: "Privacy policy" },
    notFound: {
      title: "Page not found",
      body: "The page you're looking for may have moved or doesn't exist.",
      backHome: "Back to home",
    },
  },
};

export const zhCN: Messages = {
  nav: {
    home: "首页",
    gallery: "图库",
    booking: "立即预订",
    history: "历史沿革",
  },
  header: {
    mainNavigation: "主导航",
    openMenu: "打开菜单",
    closeMenu: "关闭菜单",
    languageSwitcher: "选择语言",
    homeLink: "返回首页",
  },
  footer: {
    navigation: "页脚导航",
    languages: "语言",
    rights: "版权所有",
    contact: "联系我们",
    phone: "电话",
    email: "邮箱",
    line: "LINE",
    map: "地图",
    privacy: "隐私政策",
    cookieSettings: "Cookie 设置",
  },
  common: {
    skipToContent: "跳至主要内容",
    loading: "加载中…",
    contentPending: "此部分内容发布后将在此显示。",
    loadError: "暂时无法加载内容。",
    retry: "重试",
    close: "关闭",
    themePreview: "正在预览草稿主题（仅管理员可见）",
    exitPreview: "退出预览",
    lineChat: "通过 LINE 联系我们",
  },
  accommodation: {
    houses: "房屋",
    vipTents: "VIP 帐篷",
    camping: "自带帐篷",
    perNight: "/ 晚",
    perAdultPerNight: "/ 成人 / 晚",
    childrenFree: "{age} 岁以下儿童免费",
    upToGuests: "最多 {n} 人",
    amenities: "设施",
    viewDetails: "查看详情",
    available: "可预订",
    unavailable: "已满",
    tooManyGuests: "人数超过可容纳上限",
    tentsRemaining: "还可容纳 {n} 顶帐篷",
    campingFull: "露营区已满",
    checkIn: "入住",
    checkOut: "退房",
    guests: "人数",
    tents: "帐篷数量",
    search: "查询空房",
    searching: "查询中…",
    nights: "{n} 晚",
    chooseDates: "选择日期以查看可预订的住宿",
    backToBooking: "返回预订",
    noAccommodation: "暂无可预订的住宿",
    photos: "照片",
    checkAvailability: "查询日期",
    campingDisabled: "露营暂停开放",
    errors: {
      IN_THE_PAST: "入住日期不能早于今天",
      MUST_BE_AFTER_CHECK_IN: "退房日期必须晚于入住日期",
      STAY_TOO_LONG: "单次最多预订 30 晚",
      TOO_FAR_AHEAD: "最多可提前一年预订",
      INVALID_DATE: "日期无效",
    },
  },
  pages: {
    home: { title: "首页" },
    accommodation: { title: "住宿" },
    bookingLookup: { title: "查询预订" },
    gallery: { title: "图库" },
    booking: { title: "立即预订" },
    history: { title: "历史沿革" },
    privacy: { title: "隐私政策" },
    notFound: {
      title: "页面未找到",
      body: "您访问的页面可能已移动或不存在。",
      backHome: "返回首页",
    },
  },
};
