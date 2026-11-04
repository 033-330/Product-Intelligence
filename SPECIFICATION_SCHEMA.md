# Product Intelligence --- Specification Schema

-   **文档版本**：v0.1
-   **状态**：设计初稿，实施前需与现有 Google Sheets 表头及代码核对
-   **适用范围**：Logitech、Logitech G，以及未来扩展的其他品牌
-   **核心目标**：建立可追溯、可扩展、可比较的产品官网规格数据体系

## 1. 设计原则

1.  **产品身份与规格分离**：`Products`
    负责识别产品；规格数据保存在独立规格表中。
2.  **一项规格一行**：标准规格表采用长表结构，不为每个类别创建一张独立主表。
3.  **参数定义驱动**：类别参数由 `SpecificationDefinitions`
    配置，采集器和前端读取配置，而不是把参数列表硬编码到各个函数。
4.  **来源可追溯**：记录来源 URL、采集时间、原始值、标准化值和验证状态。
5.  **缺失不猜测**：官网未公布的值留空，并记录缺失状态；不得由 AI
    推断成事实。
6.  **后台采集**：新产品创建成功后排入任务队列，不让产品入库或页面加载等待抓取完成。
7.  **兼容现有数据**：先新增和验证结构，迁移确认后再调整旧表；不直接删除
    `Products`、`Mentions`、`Events` 等现有数据。

## 2. 数据模型概览

  --------------------------------------------------------------------------------------------------
  表                             主要职责                                 记录粒度
  ------------------------------ ---------------------------------------- --------------------------
  `Products`                     产品身份、品牌、型号、类别、官网链接     每个实体一行

  `SpecificationDefinitions`    定义参数、适用类别、单位和比较规则       每个参数定义一行

  `ProductSpecifications`       保存标准化规格值                         每个产品的每项规格一行

  `ProductSpecificationsRaw`   保存抓取到的原始值和证据                 每个产品的每项来源值一行

  `SpecificationTasks`          管理待执行、失败、重试和完成的采集任务   每次采集任务一行

  `ProductComponents`（可选）   连接套装产品与套装内独立产品             每个组件关系一行
  --------------------------------------------------------------------------------------------------

`Mouse_Specs`
可以暂时保留作为旧前端兼容表或比较视图，但不应成为唯一数据源。完成迁移验证前，不删除它。

## 3. `Products` 产品主表

推荐字段：

  ---------------------------------------------------------------------------------------------------------------------------
  字段                       含义                    规则
  -------------------------- ----------------------- ------------------------------------------------------------------------
  `product_id`               稳定的产品 ID           唯一；创建后不因名称变更而改变

  `canonical_name`           标准产品名              保留官方型号写法

  `brand`                    标准品牌名              例如 `Logitech`、`Logitech G`

  `model_number`             型号或 MPN              官网有提供时记录

  `category`                 主类别                  使用受控类别值

  `subcategory`              子类别                  可为空

  `entity_type`              实体类型                `product_model`、`product_series`、`brand`、`component`、`accessory` 等

  `official_url`             官方产品页面            尽量使用产品详情页，而非分类页

  `support_url`              官方支持页面            可选

  `region`                   来源区域或市场          例如 `US`；未知时留空

  `product_status`           产品状态                如 `active`、`discontinued`、`unknown`

  `spec_collection_status`   规格采集状态摘要        如
                                                     `not_queued`、`queued`、`in_progress`、`complete`、`partial`、`failed`

  `created_at`               创建时间                使用统一日期时间格式

  `updated_at`               最近更新时间            每次更新产品身份字段时维护
  ---------------------------------------------------------------------------------------------------------------------------

### 3.1 触发规格采集的实体规则

默认只有 `entity_type = product_model`
的具体型号会自动触发完整规格采集。

以下情况不应直接触发完整采集： - 品牌实体，例如 `Logitech` 或
`Razer`； - 产品系列实体，例如某个系列名称但没有具体型号； -
单独的零部件或传感器，例如 HERO 传感器； - 未确认是具体型号的模糊提及。

套装产品可以作为独立 `product_model`，同时通过 `ProductComponents`
关联套装内的鼠标、键盘或接收器。

## 4. `SpecificationDefinitions` 参数定义表

每行定义一个参数。推荐字段：

  ----------------------------------------------------------------------------------------------
  字段                    含义                     示例
  ----------------------- ------------------------ ---------------------------------------------
  `spec_key`              参数稳定标识             `dpi_max`

  `spec_label`            面向用户的名称           最大 DPI

  `category`              适用类别                 `mouse`；通用参数用 `common`

  `subcategory`           可选的细分适用范围       `gaming_mouse`

  `data_type`             标准数据类型             `number`、`text`、`boolean`、`enum`、`json`

  `unit`                  标准单位                 `g`、`mm`、`Hz`、`hours`、`DPI`

  `allowed_values`        枚举允许值               JSON 数组或约定的分隔格式

  `is_common`             是否为跨类别通用参数     `TRUE` / `FALSE`

  `is_comparable`         是否适合用于比较         `TRUE` / `FALSE`

  `comparison_group`      比较维度                 `sensor_performance`

  `normalization_rule`    标准化规则说明           转换为数值，单位统一为 Hz

  `is_required`           是否为该类别的重点字段   `TRUE` / `FALSE`

  `display_order`         前端展示顺序             `10`

  `is_active`             是否启用                 `TRUE` / `FALSE`

  `definition_notes`      定义、限制或解释         说明测量条件
  ----------------------------------------------------------------------------------------------

### 4.1 参数键命名规则

-   使用英文 `snake_case`，并保持稳定。
-   不要把单位写进键名，除非它是参数语义的一部分。
-   不同语义使用不同键，例如 `polling_rate_hz` 与 `bluetooth_version`
    不应合并。
-   若旧键需要替换，优先通过迁移映射处理，不直接复用旧键表达另一种含义。
-   同一参数在不同类别中含义不同时，应建立不同
    `spec_key`，避免错误比较。

## 5. `ProductSpecifications` 标准规格表

每行代表某个产品的一项标准化规格。

  字段                    含义
  ----------------------- -------------------------------------------
  `product_spec_id`       记录唯一 ID
  `product_id`            关联 `Products.product_id`
  `spec_key`              关联 `SpecificationDefinitions.spec_key`
  `normalized_value`      标准化值
  `normalized_unit`       标准化单位
  `raw_record_id`         对应的原始证据记录 ID，可为空
  `source_url`            该值的来源 URL
  `fetched_at`            抓取时间
  `verification_status`   验证状态
  `is_current`            是否为当前有效值
  `notes`                 限定条件或备注

建议以 `product_id + spec_key + is_current`
管理当前值，避免重复的当前记录。若需要保存历史，应将旧记录标记为非当前或另行保存历史版本，不要静默覆盖审计证据。

对于数值型参数，`normalized_value`
应可稳定转换为数值。对于复合尺寸、频率范围或多种连接方式，优先拆成语义明确的字段；只有在无法合理拆分时才使用
JSON 或文本。

## 6. `ProductSpecificationsRaw` 原始证据表

原始表保留官网或解析器实际观察到的值，便于复核与重新标准化。

  字段                    含义
  ----------------------- -----------------------------------------------------
  `raw_record_id`         原始记录唯一 ID
  `product_id`            关联产品
  `spec_key`              已匹配的参数键；尚未匹配时可为空
  `source_url`            具体来源页面 URL
  `source_type`           `official_product_page`、`official_support_page` 等
  `raw_label`             来源页面上的原始标签
  `raw_value`             来源页面上的原始值
  `raw_unit`              原始单位
  `normalized_value`      解析后的标准化值，可为空
  `normalized_unit`       标准单位，可为空
  `fetched_at`            抓取时间
  `parser_name`           使用的解析器或版本
  `verification_status`   校验结果
  `evidence_notes`        上下文、限定条件或解析备注

同一参数可能在不同官方页面出现多个值。不要直接丢弃冲突值；保留来源并根据页面权威性、区域、型号版本和采集时间进行判定。

## 7. `SpecificationTasks` 自动采集任务表

  字段                含义
  ------------------- ----------------------------------------------------------
  `task_id`           任务唯一 ID
  `product_id`        目标产品
  `task_type`         `initial_fetch`、`refresh`、`retry`
  `status`            `queued`、`in_progress`、`complete`、`partial`、`failed`
  `priority`          任务优先级
  `attempt_count`     已尝试次数
  `max_attempts`      最大尝试次数
  `next_attempt_at`   下次允许重试时间
  `created_at`        创建时间
  `started_at`        最近开始时间
  `finished_at`       完成时间
  `last_error`        最近错误摘要
  `source_url`        实际抓取 URL
  `parser_version`    解析器版本
  `task_notes`        处理备注

### 7.1 任务执行规则

1.  具体型号首次创建成功后，加入 `initial_fetch` 任务。
2.  产品写入成功与任务创建应尽量在同一业务流程中完成；任务失败不能回滚或删除产品。
3.  后台处理器每次只取有限数量的任务，遵守 Apps Script
    执行时限和外部服务限额。
4.  抓取失败时记录错误并安排重试；达到最大尝试次数后标记 `failed`。
5.  已存在且规格齐全的产品被再次提及，不应每次重新抓取。
6.  缺失关键规格、来源过期或用户主动刷新时，才创建新的刷新任务。
7.  通过锁或任务状态检查防止多个触发器重复处理同一任务。
8.  如果使用定时触发器，需记录其安装、执行和失败情况；不要假设 Apps
    Script 能提供无延迟的实时后台执行。

## 8. 推荐的产品类别

类别采用 `category` +
`subcategory`，以便扩展。以下为项目初始分类建议，不代表品牌官网分类的逐字复制。

  ------------------------------------------------------------------------------------------------
  `category`                          可选子类别或说明
  ----------------------------------- ------------------------------------------------------------
  `mouse`                             `gaming_mouse`、`office_mouse`、`vertical_mouse`

  `trackball`                         拇指式、手指控制式

  `pointing_device`                   其他指向设备

  `keyboard`                          `gaming_keyboard`、`office_keyboard`、`ergonomic_keyboard`

  `combo`                             鼠标键盘套装

  `headset`                           `gaming_headset`、`office_headset`

  `headphones`                        头戴式耳机

  `earbuds`                           入耳式耳机

  `speaker`                           个人或桌面音箱

  `webcam`                            个人摄像头

  `conference_camera`                 会议摄像头

  `conference_system`                 会议室系统或套装

  `speakerphone`                      会议扬声器/麦克风一体设备

  `microphone`                        独立或直播麦克风

  `gaming_controller`                 游戏控制器

  `racing_wheel`                      赛车方向盘及踏板

  `flight_simulation`                 摇杆、油门、飞行控制设备

  `presenter`                         演示翻页器

  `tablet_accessory`                  平板配件

  `lighting`                          灯光设备

  `mousepad`                          鼠标垫或桌垫

  `receiver`                          无线接收器

  `stand`                             支架或底座

  `accessory`                         其他配件

  `unknown`                           暂时无法可靠分类
  ------------------------------------------------------------------------------------------------

新类别加入前，应定义其参数模板和比较规则。不要因为某个产品名称里出现"传感器""接收器"等词就自动把它当成完整产品；应结合实体类型与官方页面判断。

## 9. 类别参数模板

以下为初始采集范围。字段只有在官方来源提供且适用于该产品时才填值。

### 9.1 通用参数（`common`）

-   `brand`
-   `canonical_name`
-   `model_number`
-   `category`
-   `subcategory`
-   `official_url`
-   `support_url`
-   `color`
-   `variant`
-   `region`
-   `weight_g`
-   `dimensions_mm`
-   `connection_type`
-   `wireless_protocol`
-   `interface`
-   `power_type`
-   `battery_type`
-   `battery_life_hours`
-   `compatible_os`
-   `compatible_devices`
-   `software_requirement`
-   `warranty_period`
-   `msrp`
-   `currency`

注：品牌、名称、型号、类别等身份字段主要存放在
`Products`；在规格字典中只对需要统一比较或展示的属性建立规格键，避免重复维护造成冲突。

### 9.2 鼠标、轨迹球及指向设备

-   `sensor_name`
-   `dpi_min`
-   `dpi_max`
-   `max_speed_ips`
-   `max_acceleration_g`
-   `polling_rate_hz`
-   `button_count`
-   `switch_type`
-   `switch_lifecycle_clicks`
-   `weight_g`
-   `dimensions_mm`
-   `battery_life_hours`
-   `connection_type`
-   `onboard_memory`
-   `programmable_buttons`
-   `rgb_lighting`
-   `charging_type`
-   `wireless_charging_support`

比较时需区分最大
DPI、最高轮询率和实际默认设置；若数值依赖固件、接收器或特定模式，应保留条件说明。

### 9.3 键盘

-   `layout_size`
-   `keyboard_layout`
-   `key_count`
-   `switch_type`
-   `switch_technology`
-   `actuation_distance_mm`
-   `actuation_force_g`
-   `polling_rate_hz`
-   `rapid_trigger_support`
-   `connection_type`
-   `battery_life_hours`
-   `backlighting`
-   `rgb_lighting`
-   `onboard_memory`
-   `programmable_keys`
-   `media_controls`
-   `hot_swappable_switches`
-   `keycap_material`

注意：机械轴、光学轴、磁性/TMR
方案的参数定义不一定相同，不能把不同机制下的指标直接视为等价。

### 9.4 耳机、头戴式耳机及耳塞

-   `driver_type`
-   `driver_size_mm`
-   `frequency_response_min_hz`
-   `frequency_response_max_hz`
-   `impedance_ohm`
-   `sensitivity_db`
-   `microphone_type`
-   `microphone_polar_pattern`
-   `microphone_frequency_response`
-   `microphone_sample_rate_hz`
-   `connection_type`
-   `bluetooth_version`
-   `multi_device_support`
-   `battery_life_hours`
-   `charging_time_hours`
-   `spatial_audio_support`
-   `active_noise_cancellation`
-   `transparency_mode`
-   `microphone_mute_method`
-   `weight_g`
-   `replaceable_earpads`

需要区分耳机扬声器单元的频响与麦克风频响；续航需记录测试条件（例如灯光、音量、ANC
状态）。

### 9.5 摄像头与 Webcam

-   `max_resolution`
-   `max_frame_rate_fps`
-   `field_of_view_diagonal_deg`
-   `field_of_view_horizontal_deg`
-   `field_of_view_vertical_deg`
-   `zoom_type`
-   `zoom_factor`
-   `focus_type`
-   `lens_type`
-   `built_in_microphone`
-   `microphone_count`
-   `hdr_support`
-   `auto_light_correction`
-   `privacy_shutter`
-   `interface`
-   `cable_length_m`
-   `mount_type`

分辨率与帧率应作为组合能力保存或记录条件，避免把不同接口、分辨率下的帧率混为一个无条件数值。

### 9.6 会议摄像头、会议系统及 Speakerphone

-   `max_resolution`
-   `max_frame_rate_fps`
-   `field_of_view_diagonal_deg`
-   `optical_zoom_factor`
-   `digital_zoom_factor`
-   `pan_tilt_support`
-   `auto_framing`
-   `speaker_tracking`
-   `camera_preset_count`
-   `microphone_count`
-   `microphone_pickup_range_m`
-   `beamforming_support`
-   `noise_cancellation_support`
-   `speaker_count`
-   `speaker_power_w`
-   `speaker_frequency_response`
-   `usb_interface`
-   `ethernet_support`
-   `poe_support`
-   `hdmi_support`
-   `recommended_room_size`
-   `mount_type`
-   `software_platform_compatibility`

会议系统经常是组合设备；必须注明规格属于主机、摄像头、麦克风还是整个套装。

### 9.7 麦克风与直播音频设备

-   `microphone_type`
-   `polar_pattern`
-   `frequency_response_min_hz`
-   `frequency_response_max_hz`
-   `sensitivity_db`
-   `sample_rate_hz`
-   `bit_depth`
-   `max_spl_db`
-   `usb_interface`
-   `analog_output`
-   `headphone_output`
-   `gain_control`
-   `mute_control`
-   `direct_monitoring`
-   `mount_type`
-   `shock_mount_included`

### 9.8 游戏控制器、赛车方向盘与飞行模拟设备

-   `axis_count`
-   `button_count`
-   `programmable_controls`
-   `pedal_count`
-   `rotation_range_deg`
-   `force_feedback_support`
-   `force_feedback_torque_nm`
-   `hat_switch_count`
-   `throttle_control`
-   `rudder_control`
-   `connection_type`
-   `platform_compatibility`
-   `mounting_type`
-   `included_accessories`

### 9.9 Presenter（演示翻页器）

-   `button_count`
-   `slide_navigation_support`
-   `digital_pointer_support`
-   `laser_type`
-   `wireless_protocol`
-   `wireless_range_m`
-   `battery_type`
-   `battery_life_hours`
-   `software_requirement`
-   `compatible_os`
-   `weight_g`
-   `dimensions_mm`

### 9.10 Combo（套装）

-   `included_component_count`
-   `bundle_type`
-   `shared_receiver_support`
-   `connection_type`
-   `compatible_os`
-   `package_dimensions_mm`
-   `package_weight_g`

套装中各个组件的规格应分别记录；套装规格仅描述整套包装、共享接收器等整套属性。用
`ProductComponents` 将套装与各组件关联。

### 9.11 鼠标垫、接收器、支架、灯光与其他配件

按类别选择适用参数：

-   鼠标垫：`surface_material`、`surface_type`、`base_material`、`dimensions_mm`、`thickness_mm`、`rgb_lighting`
-   接收器：`wireless_protocol`、`interface`、`supported_devices`、`max_polling_rate_hz`、`range_m`
-   支架：`supported_device_type`、`mount_type`、`adjustability`、`dimensions_mm`、`weight_g`
-   灯光：`brightness_lumens`、`color_temperature_k`、`rgb_support`、`power_type`、`control_method`
-   其他配件：优先记录兼容型号、接口、尺寸、材质、供电与安装方式等有官方依据的参数

## 10. 缺失值、验证状态与冲突处理

### 10.1 缺失值规则

-   Google Sheets 中建议将未知值存为空单元格；避免把字符串 `none`
    当作数值。
-   API 层可以返回 `null`，前端统一显示 `未公布` 或 `暂无数据`。
-   只有明确确认官网未公布时，才标记
    `not_published`；没有找到页面或抓取失败不能等同于官网未公布。
-   不把 AI 推断值写入已验证的规格字段。

### 10.2 建议验证状态

-   `verified_official`：已从明确的官方来源确认。
-   `parsed_official`：从官方页面自动解析，尚未人工抽查。
-   `needs_review`：值存在歧义、冲突或解析不确定。
-   `not_found`：已尝试查找但没有找到该参数。
-   `not_published`：确认官方来源未公布该参数。
-   `fetch_failed`：页面请求失败，不能说明规格不存在。
-   `conflicting_sources`：不同官方来源出现冲突。
-   `deprecated`：历史值已不再是当前值。

### 10.3 来源优先级

1.  对应型号的品牌官方产品页；
2.  对应型号的品牌官方技术规格或支持页；
3.  品牌官方手册、下载文档或技术说明；
4.  其他来源只可作为候选线索，不应直接标记为官方已验证。

不同区域、型号变体或固件模式的数值可能不同。保存
`region`、变体和条件说明，不要把不同版本的规格合并成一个值。

## 11. 跨品牌比较规则

1.  只有 `is_comparable = TRUE` 的参数默认进入竞品比较。
2.  比较前统一单位和数据类型，例如重量统一为 g、尺寸统一为
    mm、频率统一为 Hz。
3.  数值相同不代表语义相同；不同测量机制或测试条件的参数不可直接排名。
4.  对电池续航、最大帧率、最高轮询率等受条件影响的参数，记录条件和来源。
5.  不把缺失值当作 0；缺失值应显示为"未公布"。
6.  不将 AI 生成的摘要当作规格原始证据。
7.  建议对每个比较参数提供来源链接和验证状态，允许用户查看证据。
8.  如需给产品打分，必须把评分规则与原始规格分开，并记录权重和计算版本。

## 12. 自动采集流程

1.  AI 或人工识别产品实体。
2.  标准化品牌、产品名、型号与类别，并匹配已有产品和别名。
3.  判断是否为具体产品型号。
4.  若是新型号，创建 `Products` 记录并排入 `SpecificationTasks`。
5.  优先读取已知 `official_url`；若没有，才搜索品牌官方产品页面。
6.  使用确定性解析器提取页面结构化信息；无法解析的字段再考虑 AI
    辅助抽取。
7.  保存所有可追溯的原始值，再按定义字典标准化。
8.  对重复值、冲突值和不确定值执行校验。
9.  更新产品规格状态，并保留失败原因和重试次数。
10. 前端只读取缓存的数据；用户打开产品页时不执行慢速网页抓取。

### 12.1 幂等与防重复

-   同一个产品同一时刻只应有一个有效的初始采集任务。
-   重复 Newsletter 提及已存在产品时，不重复创建产品或任务。
-   同一来源、同一参数、同一抓取批次的重复结果应去重。
-   任务处理器需要检查状态并使用锁，防止并发重复执行。
-   产品匹配优先依据稳定型号/MPN，其次官方
    URL、规范化名称和别名；低置信度匹配应进入待确认流程。

## 13. 推荐 API 输出

产品详情接口可返回如下结构（示例仅说明形状，不代表真实产品数据）：

``` json
{
  "product_id": "PROD-EXAMPLE",
  "canonical_name": "Example Product",
  "brand": "Example Brand",
  "category": "mouse",
  "spec_collection_status": "partial",
  "specifications": [
    {
      "spec_key": "weight_g",
      "spec_label": "重量",
      "value": 60,
      "unit": "g",
      "verification_status": "parsed_official",
      "source_url": "https://example.com/product"
    },
    {
      "spec_key": "dpi_max",
      "spec_label": "最大 DPI",
      "value": null,
      "unit": "DPI",
      "verification_status": "not_found",
      "source_url": "https://example.com/product"
    }
  ]
}
```

API 不应返回凭据、API Key
或其他秘密配置。对外展示原始来源时，只提供必要的来源字段。

## 14. 测试与上线检查

上线前至少验证：

-   新增一个 Logitech 鼠标时只创建一个产品和一个初始任务；
-   新增键盘、耳机、摄像头、会议设备时能匹配对应参数模板；
-   品牌实体、系列实体、单独传感器不会错误触发完整产品规格采集；
-   官网抓取失败不会删除产品或阻断 Newsletter 流程；
-   重试不会产生重复规格行或重复任务；
-   缺失值不会被转换为 0 或错误的字符串；
-   原始值、标准化值、来源 URL 和验证状态能够对应；
-   套装与单独组件可以分别展示，并保留关联关系；
-   现有产品、Mentions、Events、Topics、Competitors 的关联没有被破坏；
-   前端加载产品详情时只读缓存，不触发实时抓取；
-   竞品比较不把不可比参数或缺失值错误地纳入排名。

## 15. 分阶段实施建议

### Phase 1 --- 结构与字典

-   核对当前工作簿的实际表头和现有代码。
-   建立 `SpecificationDefinitions` 初始字典。
-   明确类别、实体类型、参数键和验证状态的受控值。

### Phase 2 --- 存储与采集

-   新建
    `ProductSpecifications`、`ProductSpecificationsRaw`、`SpecificationTasks`。
-   为 Logitech / Logitech G 建立官网 URL 识别与解析规则。
-   从少量已知产品开始测试，检查原始证据与标准化结果。

### Phase 3 --- 兼容与前端

-   通过 API 返回统一规格格式。
-   让前端按类别展示参数，并提供来源链接。
-   在迁移验证通过后，再决定 `Mouse_Specs` 是否保留为兼容视图。

### Phase 4 --- 扩展

-   补齐各类别参数模板。
-   扩展到其他品牌与官网解析器。
-   增加过期检测、手动刷新和异常监控。

## 16. 实施前待确认事项

以下事项需在实际修改 Google Sheets 或代码前确认：

-   当前线上工作簿每张表的真实表头、数据类型与 ID 规则；
-   现有 `Products` 中哪些记录是具体型号、系列、品牌或组件；
-   当前 API 与前端读取 `Mouse_Specs` 的具体方式；
-   Apps Script 的触发器、运行时限、外部请求限额及任务调度配置；
-   `ProductSpecifications` 的历史保留策略和当前值唯一性约束；
-   规格参数的最终类别清单与前端展示优先级。

**重要：本文件是设计规范初稿，不会自动修改线上 Google
Sheets，也不会自动推送或部署代码。实施前必须先备份并核对现有结构。**
