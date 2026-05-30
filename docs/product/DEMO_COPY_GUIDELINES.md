# Demo Copy Guidelines

Date: 2026-05-30

Hosted OpenButler demos may use synthetic records. Those records must feel like product examples, not developer logs.

## Required Boundary

Use:

- `演示数据`
- `这些内容只用于展示产品效果，不会读取你的真实本机活动。`
- `依据：电脑活动（演示）`

Avoid:

- `Demo-only PC activity for Vercel product experience`
- `not real MineContext data`
- `mock`
- `fixture`
- `seed`
- `raw`
- internal ids or source names in ordinary UI.

## Event Copy

Use natural Chinese:

- `一段专注被记住了`
- `完成了一次本地验证`
- `查看了管家提醒`
- `整理了一条今日概览`

Avoid developer labels:

- `Check OpenButler Inbox`
- `Run local verification`
- `Review Productization docs`
- `OpenButler coding block`

## Chat Copy

For demo-only answers:

- say the answer is based on demo signals,
- name evidence in user language, such as `相册线索（演示）` or `电脑活动（演示）`,
- keep the evidence boundary,
- do not expose `phone_album`, `source_event_id`, `seed`, or raw payload names.

## Advanced Disclosure

Developer wording is allowed only under `高级与实验室`, where the user has intentionally opened technical diagnostics.

