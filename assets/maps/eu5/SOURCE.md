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

## 现今归属

现今归属的局部匹配使用 [Natural Earth 1:1000 万中国视角国界](https://www.naturalearthdata.com/about/disputed-boundaries-policy/) 5.1.1。该矢量数据由 Natural Earth 发布。争议段需另外核对自然资源部[标准地图服务](https://bzdt.tianditu.gov.cn/)。

每批控制点记录于 `scripts/eu5_present_day_control_points.json`。匹配脚本从本机游戏读取城市定位，以控制点拟合局部投影，并用未参与拟合的城市检查误差。对控制点所围范围内的完整地块，脚本统计各国覆盖比例，再用误差缓冲区筛掉可能由投影偏移造成的跨界。PNG 对照图、CSV 和 JSON 报告可用于校对。示例命令从仓库根目录运行。

```powershell
uv run --python 3.12 --with numpy --with scipy --with pillow --with pyshp python scripts/match_eu5_present_day_countries.py western-alps --game "D:/Steam/steamapps/common/Europa Universalis V" --boundaries ".cache/eu5-present-day/ne_10m_admin_0_countries_chn.zip" --review-dir ".cache/eu5-present-day"
```

示例使用 Natural Earth 的[中国视角压缩包](https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries_chn.zip)。校对后加 `--publish`，再运行下面的生成命令，匹配结果会优先用于归属提示。待核结果和校准范围外的地块继续使用已有地名规则。

批量校准使用 [GeoNames](https://www.geonames.org/export/) 的 [cities1000.zip](https://download.geonames.org/export/dump/cities1000.zip)（[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）寻找候选地标坐标，地块归属仍按变形后的国界面积计算。脚本用两种尺寸的重叠窗口分别拟合。每个窗口保留一组地标校验误差，超出控制点范围的地块不参与该窗口的归属判断。窗口结论冲突、涉及 [Natural Earth 争议区](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-breakaway-disputed-areas/)或跨境结论仅有一个窗口支持时，结果进入核对表。

```powershell
uv run --python 3.12 --with numpy --with scipy --with pillow --with pyshp --with shapely python scripts/match_eu5_present_day_atlas.py --game "D:/Steam/steamapps/common/Europa Universalis V" --boundaries ".cache/eu5-present-day/ne_10m_admin_0_countries_chn.zip" --disputed ".cache/eu5-present-day/ne_10m_admin_0_disputed_areas.zip" --gazetteer ".cache/eu5-present-day/cities1000.zip" --review-dir ".cache/eu5-present-day/atlas"
```

查看 `atlas.csv` 和 `atlas-calibration.json`，校对后加 `--publish` 将批量匹配写入 `present-day-map-matches/atlas.json`，再重建底图查找表。GeoNames 和两套 Natural Earth 下载文件的校验值记录在生成结果里。

编辑 `present-day-country-rules.json` 时，使用 `lookup/meta.js` 中的稳定地名键。能确定整个上级区域均属一国时，可以写上级规则，地块规则优先于上级规则。`crossBorder` 用于确认横跨现代国界的地块，按列出的顺序显示国名。`unresolved` 可以屏蔽上级规则在个别待核地名上的继承。

`node scripts/prepare_eu5_present_day_countries.cjs` 会重建 `lookup/present-day-countries.js` 并报告覆盖情况。地名规则未覆盖时，生成器会用原始地图共享的陆地边缘找相邻地块。至少一个相邻地块需要有地图匹配结果，并且相邻归属和所属省份或区域的证据一致。邻接推定只运行一轮，推定结果不再作为新地块的证据。争议区、校准冲突和已标记待核的地块不能自动推定。

追加 `--inference-audit` 会遮蔽部分已匹配地块，按单个地块和按整省分别回测。追加 `--unresolved` 可按上级地名列出待核地块。追加 `--neighbor-review` 会按 JSONL 输出剩余地块的各级名称、相邻地块归属、证据来源和共享边界长度，便于人工或模型分析。这几个选项均只输出报告。归属文件和待核统计仅包含普通陆地（`paint-meta.js` 中 `kind = 0`）。荒地、河湖、海域和待核地块的悬浮提示只显示原地名。

地名核对示例包括加拿大的[阿萨巴斯卡河流域](https://www.canada.ca/en/environment-climate-change/services/freshwater-quality-monitoring/water-quality-canadian-rivers.html)、法属[新喀里多尼亚和波利尼西亚](https://formation-civique.interieur.gouv.fr/fiches-par-thematiques/histoire-geographie-et-culture/atlas-de-la-france/le-territoire-de-la-france/)、拉脱维亚与爱沙尼亚边界上的[瓦尔卡–瓦尔加](https://www.valka.lv/en/about-county)、俄罗斯哈巴罗夫斯克边疆区的[尚塔尔群岛](https://fao.hlj.gov.cn/fao/c115725/202211/c00_31448106.shtml)。

沙迦按核实后的现代地名标为阿拉伯联合酋长国。[阿联酋政府](https://u.ae/en/about-the-uae/the-seven-emirates/sharjah)

批量模型核对读取 `.cache/eu5-present-day/neighbor-review.jsonl` 和 `.cache/eu5-present-day/atlas-final/atlas.csv`，提供历史地名、各级区划、共享陆地边界、已匹配邻居以及局部校准结果。用 Electron 运行 `scripts/review_eu5_present_day_countries.cjs`，调用当前启用的本机 AI 配置。已完成的批次保存在 `.cache/eu5-present-day/llm-review/`，中断后可以继续。请求只包含 EU5 模板的地理资料。

用 Node 运行 `scripts/merge_eu5_present_day_llm_review.cjs` 可生成逐地块核对表。加 `--publish` 会写出 `present-day-llm-matches.json`，再重建归属查找表即可显示。只有高置信的单一归属、获得已有地图证据支持并通过冲突检查的判断才会写入。其余模型建议保留在核对表中。

对归属仍为空的地块，可以在批量地图校准命令上追加 `--unassigned-only`。面积占比按地块的完整面积计算，未对上的区域不会重新分配到已识别国家。单国达到 80% 时采用该国，否则有两个或更多国家各达到 20% 时按面积排序并列。若完整覆盖的窗口均未达到这两个阈值，就采用这些窗口中平均面积占比唯一最大的国家。最高占比并列、控制点覆盖不足、校准冲突或涉及争议要素的地块按原规则留待核对。追加 `--publish` 会写入 `present-day-overlap-matches.json`。重建查找表时，此文件补齐原本没有归属的地块。

`scripts/refine_eu5_present_day_coverage.py` 读取上一轮的 `--previous-review`（`area-overlap.csv`），只重查校准缺失或覆盖不完整的地块。它使用 320 和 480 像素的重叠窗口，并允许校准范围延伸到通过留出误差检查的外侧控制点。不同窗口的地块像素合并计数一次。窗口在同一点判断不一致时，该点面积保留为未知。若已确认面积达到整个地块的 80%，剩下未覆盖的部分不影响单国判断。多国结论须在未知部分的可能分配下仍满足阈值。输出 `coverage-refinement.csv`，加 `--publish` 可将通过的结果合并入面积归属文件。

`scripts/apply_eu5_disputed_boundary_policy.py` 使用已有校准窗口重算与指定争议要素直接重叠的地块，包括已有标签的地块。Natural Earth 中国视角矢量和争议区要素用于定位，归属依据中国公开的外交口径。用 `--area-review` 和 `--dispute-audit` 读取原始面积报告和直接重叠审计表，重复 `--feature` 可指定多个要素。加 `--publish` 将通过的结果写入 `present-day-disputed-matches.json` 的 `officialLocations`，重建时优先于历史匹配。`present-day-country-rules.json` 的 `official` 用于精确地名判定和无明确归属的留待核对地块。朝韩非军事区沿两幅要素共用的军事分界线划分。克什米尔中的印度/巴基斯坦并列标注表示争议涉及两方，西撒哈拉标注采用地区名。

北婆罗洲的沙巴地块按马来西亚处理，马尔维纳斯群岛按中方支持阿根廷主权要求的口径处理，塞浦路斯、索马里兰和纳戈尔诺-卡拉巴赫分别按塞浦路斯、索马里和阿塞拜疆处理。马约特按中国代表在联大关于科摩罗的表述处理。拜科努尔按中国国家航天局所述的哈萨克斯坦领土处理。[沙巴及斗湖](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/yz_676205/1206_676716/1206x2_676736/201602/t20160223_9298509.shtml) · [马尔维纳斯群岛](https://www.mfa.gov.cn/fyrbt_673021/202202/t20220208_10640207.shtml) · [塞浦路斯](https://www.mfa.gov.cn/zwbd_673032/wjzs/202609/t20260909_12019017.shtml) · [索马里兰](https://www.mfa.gov.cn/web/ziliao_674904/1179_674909/202601/t20260112_11811361.shtml) · [纳卡](https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/yz_676205/1206_676284/fyrygth_676292/200011/t20001107_9287834.shtml) · [马约特](https://digitallibrary.un.org/record/283594?ln=en) · [拜科努尔](https://www.cnsa.gov.cn/n6758823/n6759010/c6777907/content.html)

戈兰高地及缓冲区采用叙利亚领土边界。巴以按中方支持的 1967 年边界为基础校准，加沙、约旦河西岸和东耶路撒冷按巴勒斯坦处理。EU5 耶路撒冷地块的四个完整窗口中，巴勒斯坦面积均超过 83%。德涅斯特河左岸区域按摩尔多瓦领土处理，跨国界的游戏地块仍以面积判断。校准阶段将南千岛群岛、直布罗陀、埃塞奎博、阿卜耶伊等地块交由人工核对。[戈兰高地](https://www.mfa.gov.cn/gjhdq_676201/gj_676203/yz_676205/1206_677100/1206x2_677120/202501/t20250109_11529636.shtml) · [巴以问题](https://www.mfa.gov.cn/web/ziliao_674904/zcwj_674915/202311/t20231129_11189399.shtml) · [摩尔多瓦](https://www.mfa.gov.cn/gjhdq_676201/gj_676203/oz_678770/1206_679498/1207_679510/200107/t20010721_9344865.shtml) · [南千岛](https://www.mfa.gov.cn/fyrbt_673021/202202/t20220211_10641427.shtml) · [埃塞奎博](https://www.mfa.gov.cn/fyrbt_673021/202312/t20231215_11203301.shtml) · [阿卜耶伊](https://www.mfa.gov.cn/web/gjhdq_676201/gjhdqzz_681964/zgzyjz_148230/zwbd_688978/202611/t20261117_12060878.shtml)

2026-11-27 根据 `EU5_今属待核_51地块.mapdesign` 的着色，将 51 个地块的人工指定归属写入 `present-day-country-rules.json` 的 `official`。斜杠分隔的国家按原顺序并列显示。

休达和梅利利亚的 EU5 地块覆盖西班牙飞地与周围的摩洛哥陆地，采用两国并列标注以保留飞地归属。[中国领事服务网](https://cs.mfa.gov.cn/ljmdd/oz_652287/xby_654955/)

`scripts/refine_eu5_present_day_dispute_buffer.py` 复查只落在争议边界校准误差带内的地块，读取 `area-overlap.csv` 和直接重叠审计表。完整覆盖的窗口须在至少两种尺度上给出一致的单国结论。稳定面积不足时，可以用 GeoNames 国家代码交叉核对，或用接壤地块佐证高度一致的面积结果。接壤复核要求至少三个完整窗口、同一国最低占比达到 98%、至少两个已确认的同国邻居，且接壤处无相反归属证据。确认归属的同国邻居须覆盖至少一半的陆地接壤边界，完整窗口均测得 100% 时要求至少三分之一。脚本通过 Node 的 `--neighbor-review` 读取接壤边界。加 `--publish` 将通过核对的结果写入 `present-day-overlap-matches.json`。

`scripts/complete_eu5_present_day_countries.py` 批量复查尚无标注的普通陆地。它使用待核清单、接壤记录、原始面积报告和重新拟合的局部窗口。`--gazetteer` 接受 GeoNames 的 `allCountries.zip`，可增加乡镇、历史地名和小岛控制点。校准只使用本轮已知地块作控制点，模型建议与地理证据交叉核对。加 `--publish` 将结果写入 `present-day-remaining-matches.json`。证据较弱的结果显示为「今属推定」。直接重叠的争议和公开口径待厘定的单一归属继续核对。[GeoNames 地名数据](https://www.geonames.org/export/)

对投影畸变较大或控制点稀少的区域，用海岸、山脉和河流核对地块的位置。历史地名和现代地名能够直接对应的地块写入 `official`，仅能通过地形和邻接关系判断的地块写入 `regionalEstimates`。参考资料包括[几内亚比绍的比热戈斯群岛](https://www.unesco.org/en/mab/bolama-bijagos)、[塞拉利昂岛屿](https://tourism.gov.sl/islands/)、[冈比亚的宾坦](https://meccnar.gov.gm/information-protected-areas-gambia)、[智利市镇](https://www.bcn.cl/siit/mapoteca/comunas)、[阿拉斯加的特林吉特地名](https://sealaskaheritage.org/wp-content/uploads/2024/03/Edwards-Dictionary-of-Tlingit.pdf)和[圣克罗伊岛](https://www.nps.gov/places/islands-on-the-horizon.htm)。

几个跨过面积阈值的具名地块按地名核对后写入地名规则。来源包括联合国的[加沙市](https://palestine.un.org/en/contact-us)和[阿尤恩](https://www.un.org/geospatial/sites/default/files/2026-11/MINURSO%203691%20R102%20Aug26%20120%25.pdf)、索马里旅游部门的[泽拉和迈德](https://tourism.gov.so/posts/af497fdf-1a86-49b3-bade-4ec9713a3ba9)、仁川市的[仁州沿革](https://www.incheon.go.kr/en/EN010101)，以及乌克兰国家百科全书的[锡瓦什与阿拉巴特沙洲](https://vue.gov.ua/%D0%90%D1%80%D0%B0%D0%B1%D0%B0%D1%82%D1%81%D1%8C%D0%BA%D0%B0_%D1%81%D1%82%D1%80%D1%96%D0%BB%D0%BA%D0%B0)。

未复制寻路数据或渲染贴图。2026-10-21 为名称工具补充了本机 `game/main_menu/localization/simp_chinese/` 中的 `region_names_l_simp_chinese.yml`、`province_names_l_simp_chinese.yml`、`area_l_simp_chinese.yml` 和 `location_names/location_names_l_simp_chinese.yml`，保存于本目录 `localization/`。衍生文件包括 `basemap-no-borders.png` 和 `lookup/` 下的命中索引与名称元数据，由 `scripts/prepare_map_tools.py` 重建。原始地图资产的再分发许可尚未确认。
