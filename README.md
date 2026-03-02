# MoveCar - 挪车通知系统

智能挪车通知系统Docker版，扫码即可通知车主，保护双方隐私。  
`linux/amd64, linux/arm64`
> 与原作者cloudflare workers版本的区别：  
> 1. 增加车牌号显示，未设置则不显示 [CAR_NUMBER]
> 1. 设置手机号的情况下，可隐藏手机号，只有当车主确认后，请求者才能看到手机号 [HIDE_PHONE_NUMBER]
> 1. 未共享位置的情况下，隐藏高德和苹果地图的查看位置按钮
> 1. 可限制单IP的5分钟内可发送通知数和当天可发送通知数 [RATE_LIMIT_5MIN,RATE_LIMIT_DAILY]
> 1. 可设置请求者发送通知并且车主确认后的一段时间内，同一请求者再次扫码直接显示车主已确认界面 [RECORD_TIME]
> 
> **重启容器重置所有计数、时间、ip记录。*  
> **未完全测试全部功能，可能存在bug。*

## Docker 部署教程

### Docker Compose

```
services:
  movecar:
    image: viklion/movecar:latest
    container_name: movecar
    restart: unless-stopped
    ports:
      - "3000:3000"             #映射端口
    environment:
      - BARK_URL=               #bark推送地址
      - PHONE_NUMBER=           #手机号
      - HIDE_PHONE_NUMBER=false #是否隐藏手机号，true:只有车主确认后才显示，false:发送通知后就显示（默认：false）
      - CAR_NUMBER=             #车牌号
      - RATE_LIMIT_5MIN=0       #相同IP在5分钟内最多发送的通知次数，0表示不限制（默认：0）
      - RATE_LIMIT_DAILY=0      #相同IP每天最多发送的通知次数，0表示不限制（默认：0）
      - RECORD_TIME=0           #IP确认记录的有效时间，单位秒，0为关闭记录功能（默认：0）
      # - ALLOWED_COUNTRIES=    #允许访问的国家代码，多个用逗号分隔 例如: CN,HK,MO,TW
      # - ENABLE_GEO_CHECK=     #启用地理位置检查 true/false
```

## 界面预览

| 请求者页面 | 车主页面 |
|:---:|:---:|
| [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/lesnolie/movecar/blob/main/preview-requester.html) | [🔗 在线预览](https://htmlpreview.github.io/?https://github.com/lesnolie/movecar/blob/main/preview-owner.html) |

## 为什么需要它？

- 🚗 **被堵车却找不到车主** - 干着急没办法
- 📱 **传统挪车码暴露电话** - 隐私泄露、骚扰电话不断
- 😈 **恶意扫码骚扰** - 有人故意反复扫码打扰
- 🤔 **路人好奇扫码** - 并不需要挪车却触发通知

## 这个系统如何解决？

- ✅ **不暴露电话号码** - 通过推送通知联系，保护隐私
- ✅ **双向位置共享** - 车主可确认请求者确实在车旁
- ✅ **无位置延迟 30 秒** - 降低恶意骚扰的动力
- ✅ **免费部署** - Cloudflare Workers 免费额度完全够用
- ✅ **无需服务器** - Serverless 架构，零运维成本

## 为什么使用 Bark 推送？

- 🔔 支持「紧急 / 重要 / 警告」通知级别
- 🎵 可自定义通知音效
- 🌙 **即使开启勿扰模式也能收到提醒**
- 📱 安卓用户：原理相通，将 Bark 替换为安卓推送服务即可（如 Pushplus、Server酱）

## 使用流程

### 请求者（需要挪车的人）

1. 扫描车上的二维码，进入通知页面
2. 填写留言（可选），如「挡住出口了」
3. 允许获取位置（不允许则延迟 30 秒发送）
4. 点击「通知车主」
5. 等待车主确认，可查看车主位置

### 车主

1. 收到 Bark 推送通知
2. 点击通知进入确认页面
3. 查看请求者位置（判断是否真的在车旁）
4. 点击确认，分享自己位置给对方

### 流程图

```
请求者                              车主
  │                                  │
  ├─ 扫码进入页面                     │
  ├─ 填写留言、获取位置                │
  ├─ 点击发送 ───────────────────────→├─收到通知
  │                                  │
  ├─ 等待中...                        ├─ 查看请求者位置
  │                                  ├─ 点击确认，分享位置
  │                                  │
  ├─ 收到确认，查看车主位置 ←──────────┤
  │                                  │
  ▼                                  ▼
```

## 制作挪车码

### 生成二维码

1. 使用你的域名反向代理
2. 使用任意二维码生成工具（如 草料二维码、QR Code Generator）
3. 将域名转换为二维码并下载

### 美化挪车牌

使用 AI 工具生成精美的装饰设计：

- **Nanobanana Pro** - 生成装饰图案和背景
- **ChatGPT** - 生成创意设计图

制作步骤：

1. 用 AI 工具生成你喜欢的装饰图案
2. 将二维码与生成的图案组合排版
3. 添加「扫码通知车主」提示文字
4. 打印、过塑，贴在车上

> 💡 用 AI 生成独一无二的挪车牌，让你的爱车更有个性！

### 效果展示

![挪车码效果](demo.jpg)

## 安全设置（推荐）
****docker版未测试是否有效***

环境变量设置：
```bash
# 启用地理位置检查
ENABLE_GEO_CHECK=true

# 只允许中国地区访问
ALLOWED_COUNTRIES=CN
```
为防止境外恶意攻击，建议只允许中国地区访问



> ⚠️ 曾经被境外流量攻击过，强烈建议开启地区限制！

## License

MIT



