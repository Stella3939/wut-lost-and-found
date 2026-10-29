// config.js —— 全站配置（"填空题"）：切换应用场景时，只需要改这一个文件
// 改完把 seedVersion 加 1，再运行「更新网站.bat」，浏览器会自动重置演示数据
// 商场、景区等场景的现成配置参考 js/config-examples.js

const SITE_CONFIG = {
  siteName: '武汉理工大学失物招领', // 网站标题
  orgName: '武汉理工大学',           // 场所/机构名称（数据看板等处使用）
  slogan: '让每一件失物都能找到回家的路',
  areaLabel: '校区',                 // 区域的叫法：校区 / 楼层 / 分区 / 片区…
  areas: ['南湖', '鉴湖', '马房山东苑', '马房山西苑', '余家头', '军山'],
  categories: ['证件卡品类', '电子数码类', '学习用具类', '生活用具类', '其他类'],
  contactHint: 'QQ / 手机号',
  seedVersion: 2                     // 场景/数据每改一次就 +1
};
