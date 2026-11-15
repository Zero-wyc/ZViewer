# Live2D 资源说明

## Cubism Core（`core/live2dcubismcore.min.js`）

- 来源：Live2D 官方 Cubism SDK for Web
  <https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js>
- 版权：(C) Live2D Inc.；该文件在许可协议中属于 "Redistributable Code"，
  随本应用分发，许可全文见文件头注释与
  <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 不要改写、混淆或拆分这个文件；升级时整份替换。

## CubismWebFramework

由 npm 包 `untitled-pixi-live2d-engine` 内置（pristine 镜像），
适用 Live2D Open Software License，许可文本在
`node_modules/untitled-pixi-live2d-engine/vendor/cubism/LICENSE.md`。

## 内置模型（`models/`）

目录约定：`models/<id>/<id>.model3.json`，并在 `models/index.json` 里登记：

```json
{ "models": [{ "id": "hiyori", "label": "日和" }] }
```

可选 `thumb`：模型目录里的预览图文件名，选择器会把它当作条目缩略图。

```json
{ "models": [{ "id": "hiyori", "label": "日和", "thumb": "preview.png" }] }
```

内置模型是前端静态资源，服务端不会像「模型库」那样从贴图自动生成缩略图，
所以这张图要自己放（建议 160px 见方内的透明 PNG）；不填则条目显示首字。

模型素材的授权由加入者负责（Live2D 官方示例模型适用其 Free Material License，
商用前请自行确认条款）。仓库默认不附带任何模型，清单为空时前端会提示
「还没有内置模型」，房主可用自定义 URL 先加载一个。
