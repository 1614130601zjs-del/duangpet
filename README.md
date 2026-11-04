# 小小桌宠（Little Pet）

独立的 SillyTavern 扩展。悬浮球打开桌宠面板，上传透明 PNG 角色图后，可以直接在图上戳、拉、捏。

## 初版功能

- 可拖动并吸附屏幕左右边缘的悬浮球。
- 上传 PNG、WebP、JPG 作为桌宠本体。
- 图片保存在浏览器 IndexedDB，本地持久化，不写入聊天记录。
- WebGL 网格形变：手指按在图片任意位置拖动，局部跟随。
- 可调笔刷范围、拉扯力度、边缘柔和度。
- 松手后通过弹簧阻尼自动回弹。
- UI 颜色跟随 SillyTavern 当前主题变量。

## 安装

在 Termux 中执行：

```bash
cd ~/SillyTavern/data/default-user/extensions
git clone https://github.com/1614130601zjs-del/duangpet.git
```

刷新或重启 SillyTavern 后即可使用「小小桌宠」悬浮球。

## 操作

1. 点击悬浮球打开面板。
2. 选择一张透明 PNG。
3. 手指按住角色任意位置拖动；笔刷范围决定影响区域，中心受力最强、边缘逐渐衰减。
4. 松手后角色自动回弹。
5. 可在面板下方调整笔刷范围、力度和边缘柔和度。

## 技术来源

局部 WebGL 网格形变、高斯权重衰减与弹簧回弹实现，基于作者自己的 [duangduang](https://github.com/1614130601zjs-del/duangduang) 果冻引擎做独立适配。小小桌宠不依赖拾帧，也不会读取或修改聊天消息中的图片。

## 当前版本

0.1.0 — 初版骨架。
