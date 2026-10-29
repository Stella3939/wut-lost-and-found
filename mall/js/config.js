// mall/js/config.js —— 商场版场景配置（Three.js 立体楼宇）
// 换场景只改本文件；改完把 seedVersion 加 1 并运行「更新网站.bat」

const SITE_CONFIG = {
  siteName: '星光购物中心失物招领',
  orgName: '星光购物中心',
  slogan: '逛街无忧，失物速归',
  areaLabel: '楼层',
  areas: ['B1', '1F', '2F', '3F', '4F', '5F'],
  categories: ['证件卡品类', '电子数码类', '学习用具类', '生活用具类', '其他类'],
  contactHint: '电话 / 微信',
  storagePrefix: 'wutlf_mall', // 数据存储命名空间（三个站点互不干扰）
  seedVersion: 3,

  // 管理端立体地图（Three.js 真 3D 楼宇，可旋转缩放、点击楼层看数据）
  map: {
    mode: '3d',
    building: {
      width: 3.2,    // 楼板宽
      depth: 2.2,    // 楼板深
      height: 0.34,  // 每层高度
      gap: 0.12      // 层间空隙
    }
  }
};
