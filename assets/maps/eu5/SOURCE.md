# EU5 地图原始文件

- 复制日期：2026-10-20
- 来源：本机游戏目录 `D:\Steam\steamapps\common\Europa Universalis V\game\in_game\map_data`
- 文件：`locations.png`、`rivers.png`、`definitions.txt`、`default.map`、`location_templates.txt`、`named_locations/00_default.txt`
- 完整性：所有复制文件均通过来源与目标的 SHA-256 一致性校验；大小和校验值见 `manifest.json`。
- 游戏版本号尚未确认；文件均取自同一个本机安装目录。

## 图像文件头检查

| 文件 | 尺寸 | 格式 |
| --- | --- | --- |
| locations.png | 16384 × 8192 | 8 位 RGB PNG |
| rivers.png | 16384 × 8192 | 8 位索引色 PNG |

两张地图尺寸一致，可作为后续区域与河流图层对齐的输入。实际方向、河流调色板语义和区域匹配仍需导入时验证。已检查 PNG 签名、IHDR 和复制完整性，尚未执行完整图像解码或地图语义校验。

本目录中的地图输入现以本机文件为准。此前从 GitHub 下载的 locations.png 与本机文件不同，已连同原来源说明备份至 `reference-download/`，不应与当前配套定义混用。游戏安装目录未作修改。

未复制寻路数据或渲染贴图。2026-10-21 为名称工具补充了本机 `game/main_menu/localization/simp_chinese/` 中的 `region_names_l_simp_chinese.yml`、`province_names_l_simp_chinese.yml`、`area_l_simp_chinese.yml` 和 `location_names/location_names_l_simp_chinese.yml`，保存于本目录 `localization/`。衍生文件包括 `basemap-no-borders.png` 和 `lookup/` 下的命中索引与名称元数据，由 `scripts/prepare_map_tools.py` 重建。原始地图资产的再分发许可尚未确认。
