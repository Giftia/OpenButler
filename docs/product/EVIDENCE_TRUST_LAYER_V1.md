# Evidence Trust Layer V1

依据层是 OpenButler 的信任资产。用户不需要看内部字段，但必须知道结论从哪里来、可信到什么程度、边界在哪里。

## 普通层

提醒、时间线和问管家都用同一套表达：

- 来源：电脑活动、相册线索、管家整理、手动记录。
- 可信度：高、中、低，或百分比转成自然说法。
- 边界说明：这个结论来自本地时间线整理，不代表远程系统实时状态。
- 隐私说明：未上传数据，未复制本地截图。

## 高级层

高级与实验室可以保留：

- source type
- event id
- evidence refs
- harness status
- API 调试信息

普通页面不展示本地截图路径、raw ref、source_event_id、mock、seed 或 debug 文案。

## 当前契约

本轮不新增 `GET /api/butler/insights/{id}/evidence`。

当前证据详情继续使用接口返回的 inline evidence。只有当证据 payload 明显变重，或者 OpenClaw 需要单独查询证据时，才考虑新增独立 endpoint。

