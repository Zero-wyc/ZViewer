package api

import (
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"os"
	"path"
	"path/filepath"
	"strings"

	// 贴图可能是 webp（新版 Cubism 导出支持），解码器必须注册进 image.Decode。
	_ "golang.org/x/image/webp"
	// png/jpeg/gif 走标准库；这里显式引入是为了本文件自洽，
	// 不依赖同包别的文件恰好 import 过。
	_ "image/gif"
	_ "image/jpeg"

	"golang.org/x/image/draw"
)

// 模型库缩略图。
//
// 为什么需要它：选择器里以前只有「名字 + 大小」，用户挑模型等于开盲盒——
// 挑错了要等最长 45 秒加载失败才知道。缩略图取模型自带的第一张贴图缩到
// 160px，至少能看出配色与画风。
//
// 它是**贴图图集**，不是渲染出来的成品立绘：图集里各部件是散开的。这仍是
// 现有条件下唯一能在服务端拿到的视觉信息（在服务端跑 Cubism 渲染不现实），
// 所以只当「参考」用，界面上也做得小。
const (
	// 缩略图文件名。
	//
	// 不能以 "." 开头：静态下发会拒绝任何点开头的路径段（`.meta.json` 正是
	// 靠这条规则不公开）。双下划线是因为它几乎不可能与模型自带素材重名；
	// 万一重名，生成前会先检查存在性并跳过，绝不覆盖原包里的文件。
	live2dThumbFile = "__thumb.png"

	// 缩略图长边。界面里最宽只用到 32px，2 倍屏 + 未来放大都够。
	live2dThumbSize = 160

	// 允许解码的贴图像素上限。
	//
	// 8192² 的 RGBA 解码后是 268MB，几个人同时上传就能把服务端打穿。
	// 超限的模型只是没有缩略图，功能不受影响。
	live2dThumbMaxPixels = 4096 * 4096

	// 同时解码的张数。解码是纯 CPU + 大内存操作，必须限并发。
	live2dThumbParallel = 2

	// 判定「这行/这列有内容」的 alpha 阈值。图集边缘常有半透明的噪点，
	// 阈值取小了裁不掉。
	live2dThumbAlphaCut = 8
)

// live2dThumbSem 限制并发解码。放在包级是因为上传与启动回填共用。
var live2dThumbSem = make(chan struct{}, live2dThumbParallel)

// live2dThumbPath 返回缩略图的磁盘路径。
func (s *Server) live2dThumbPath(modelID string) string {
	return filepath.Join(s.live2dModelDir(modelID), live2dThumbFile)
}

// live2dHasThumb 判断某个模型有没有可用缩略图。
//
// 用 Stat 而不是记在 .meta.json 里：启动回填（老模型）补出来的缩略图不该
// 反过来要求改元数据，否则元数据里会留下「当时没有」的过期结论。
func (s *Server) live2dHasThumb(modelID string) bool {
	if !live2dModelIDPattern.MatchString(modelID) {
		return false
	}
	info, err := os.Stat(s.live2dThumbPath(modelID))
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

// writeLive2DThumb 在模型目录里生成 __thumb.png。
//
// 调用方一律忽略返回的 error：缩略图是锦上添花，模型没缩略图照样能用。
// 失败最常见的两种情形也很正常——贴图是加密/非标准格式，或者原包带了
// 一个同名的 __thumb.png（那就直接跳过，绝不覆盖用户素材）。
func writeLive2DThumb(modelDir string) error {
	dst := filepath.Join(modelDir, live2dThumbFile)
	if _, err := os.Stat(dst); err == nil {
		return errLive2DThumbExists
	}

	rel, ok := pickLive2DTexture(filepath.Join(modelDir, live2dEntryFile))
	if !ok {
		return errors.New("模型没有可用的贴图")
	}

	live2dThumbSem <- struct{}{}
	defer func() { <-live2dThumbSem }()

	src, err := decodeLive2DTexture(modelDir, rel)
	if err != nil {
		return err
	}
	thumb := renderLive2DThumb(src)

	// 先写临时文件再改名：静态下发是并发的，直接写会让正在看的客户端
	// 读到半个 PNG（浏览器那边表现为「图片坏了」，刷新才好）。
	tmp, err := os.CreateTemp(modelDir, ".thumb-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if err := png.Encode(tmp, thumb); err != nil {
		tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

var errLive2DThumbExists = errors.New("已有同名文件，跳过")

// pickLive2DTexture 从 model3.json 里取第一张贴图的相对路径。
//
// 取第一张而不是「最大的一张」：Cubism 导出顺序里 Textures[0] 就是主体
// （脸/身体）所在的那张，而尺寸最大的往往是背景或特效层。
func pickLive2DTexture(entryPath string) (string, bool) {
	raw, err := os.ReadFile(entryPath)
	if err != nil {
		return "", false
	}
	var doc struct {
		FileReferences struct {
			Textures []string `json:"Textures"`
		} `json:"FileReferences"`
	}
	if err := json.Unmarshal(decodeLive2DJSON(raw), &doc); err != nil {
		return "", false
	}
	for _, rel := range doc.FileReferences.Textures {
		if strings.TrimSpace(rel) != "" {
			return rel, true
		}
	}
	return "", false
}

// decodeLive2DTexture 把一张贴图解成 image.Image。
//
// 先 DecodeConfig 只读文件头拿尺寸，超过像素上限就直接放弃：这一步不会
// 分配整张位图，是「大贴图不打穿内存」的关键。
func decodeLive2DTexture(modelDir, rel string) (image.Image, error) {
	clean := path.Clean("/" + strings.ReplaceAll(rel, "\\", "/"))
	relSlash := strings.TrimPrefix(clean, "/")
	if relSlash == "" || relSlash == "." || strings.HasPrefix(relSlash, "../") {
		return nil, errors.New("贴图路径非法")
	}
	full := filepath.Join(modelDir, filepath.FromSlash(relSlash))
	if !strings.HasPrefix(full, filepath.Clean(modelDir)+string(os.PathSeparator)) {
		return nil, errors.New("贴图路径越界")
	}

	f, err := os.Open(full)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	cfg, format, err := image.DecodeConfig(f)
	if err != nil {
		return nil, err
	}
	switch format {
	case "png", "jpeg", "gif", "webp":
	default:
		return nil, errors.New("不支持的贴图格式：" + format)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, errors.New("贴图尺寸无效")
	}
	if cfg.Width*cfg.Height > live2dThumbMaxPixels {
		return nil, errors.New("贴图过大")
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}
	img, _, err := image.Decode(f)
	return img, err
}

// renderLive2DThumb 裁掉透明边、等比缩到长边 160。
//
// 裁透明边很值：图集里部件常集中在一角，不裁的话缩略图里主体只占几个像素。
func renderLive2DThumb(src image.Image) *image.NRGBA {
	rect := alphaBounds(src)
	sw, sh := rect.Dx(), rect.Dy()
	if sw <= 0 || sh <= 0 {
		rect = src.Bounds()
		sw, sh = rect.Dx(), rect.Dy()
	}
	dw, dh := live2dThumbSize, live2dThumbSize
	if sw >= sh {
		dh = scaleLive2DThumbSide(sh, sw)
	} else {
		dw = scaleLive2DThumbSide(sw, sh)
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	// CatmullRom 在预乘空间插值，透明边缘不会出现黑边。
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, rect, draw.Src, nil)
	return dst
}

// scaleLive2DThumbSide 按长边等于 160 求短边，至少 1 像素。
func scaleLive2DThumbSide(side, longest int) int {
	if longest <= 0 {
		return 1
	}
	out := (side*live2dThumbSize + longest/2) / longest
	if out < 1 {
		out = 1
	}
	if out > live2dThumbSize {
		out = live2dThumbSize
	}
	return out
}

// alphaBounds 求「非全透明像素」的包围盒。
//
// 只对 NRGBA/RGBA 做精确扫描（PNG 解码出来的就是这两种），其余类型直接
// 返回整幅：JPEG 没有 alpha，本来也不需要裁。
func alphaBounds(img image.Image) image.Rectangle {
	b := img.Bounds()
	switch src := img.(type) {
	case *image.NRGBA:
		return scanAlphaBounds(b, func(x, y int) uint8 {
			return src.Pix[src.PixOffset(x, y)+3]
		})
	case *image.RGBA:
		return scanAlphaBounds(b, func(x, y int) uint8 {
			return src.Pix[src.PixOffset(x, y)+3]
		})
	}
	return b
}

// scanAlphaBounds 逐像素扫 alpha。4096² 约四千万次取字节，几十毫秒，
// 每个模型只会做一次。
func scanAlphaBounds(b image.Rectangle, alphaAt func(x, y int) uint8) image.Rectangle {
	minX, minY := b.Max.X, b.Max.Y
	maxX, maxY := b.Min.X-1, b.Min.Y-1
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if alphaAt(x, y) <= live2dThumbAlphaCut {
				continue
			}
			if x < minX {
				minX = x
			}
			if x > maxX {
				maxX = x
			}
			if y < minY {
				minY = y
			}
			if y > maxY {
				maxY = y
			}
		}
	}
	if maxX < minX || maxY < minY {
		// 整张全透明：没有可裁的主体，交给上层退回整幅。
		return image.Rectangle{}
	}
	return image.Rect(minX, minY, maxX+1, maxY+1)
}

// warmLive2DThumbs 给「本次改动之前入库」的模型补缩略图。
//
// 必须在后台跑：一个 4096² 贴图解码要几十毫秒到几百毫秒，几十个模型同步
// 做会让启动卡住十几秒。串行走（配 live2dThumbSem）就是为了不叠内存。
func (s *Server) warmLive2DThumbs() {
	for _, meta := range s.readLive2DModels() {
		if s.live2dHasThumb(meta.ID) {
			continue
		}
		if err := writeLive2DThumb(s.live2dModelDir(meta.ID)); err != nil {
			continue
		}
	}
}
