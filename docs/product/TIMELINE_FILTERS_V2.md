# Timeline Filters V2

Updated: 2026-05-30

## Filter Dimensions

Timeline V2 exposes three ordinary-user filters:

| Dimension | Options |
|---|---|
| Time | 今天, 昨天, 近 7 天, 全部 |
| Source | 全部来源, 电脑活动, 本机回溯, 相册线索, 工位观察, 管家整理, 手动记录, 系统 |
| Event | 全部事件, 专注时段, 切换较多, 管家提醒, 可自动化流程, 物品位置, 光照状态, 安防事件, 成就记录, 数据状态, 电脑活动 |

The current implementation filters in the frontend ViewModel. It reuses `GET /api/butler/timeline` and does not require backend contract changes.

## Empty State

If the backend returns no events, the page explains that local data sources must be connected first. If filters exclude all events, the page says this filter has no events and suggests widening time, source, or event conditions.

## Source Mapping

- `minecontext`, `pc_activity` -> 电脑活动
- `godview` -> 本机回溯
- `phone_album` -> 相册线索
- `workstation_vision` -> 工位观察
- `butler_core`, `rule_engine`, `timeline_event` -> 管家整理
- `manual` -> 手动记录
- `system` -> 系统

## Event Mapping

- `focus_block` -> 专注时段
- `context_switch` -> 切换较多
- `insight`, `daily_overview` -> 管家提醒
- `workflow_candidate` -> 可自动化流程
- `object_location` -> 物品位置
- `lighting_context` -> 光照状态
- `security_event`, `motion_detected`, `presence_detected` -> 安防事件
- `achievement` -> 成就记录
- `data_quality_notice` -> 数据状态
- `pc_activity` -> 电脑活动
