# -*- coding: utf-8 -*-
"""
步骤 4：在流水线生成的 config.json 中注入自定义站点，放到 sites 数组首位。

运行时机：必须在 update_config.py / test_api_availability.py / separate_sources.py
全部执行完毕之后、git-auto-commit 之前，否则自定义条目会被前序步骤覆盖。
幂等：重复执行不会产生重复条目（先按 key 删除旧条目再前插）。
"""
import json
import os

CONFIG_FILE = 'config.json'

# 自定义站点（按需修改，格式与 TVBox sites 数组条目一致，字段原样写入）
CUSTOM_SITES = [
    {
        "key": "dbzy",
        "name": "豆瓣资源",
        "type": 1,
        "api": "https://dbzy.tv/api.php/provide/vod",
        "searchable": 1,
        "quickSearch": 1,
        "filterable": 1
    }
]


def main():
    if not os.path.exists(CONFIG_FILE):
        print(f"错误: 找不到 {CONFIG_FILE}，请确认前序步骤已生成。")
        return

    with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)

    sites = config.get("sites")
    if not isinstance(sites, list):
        print(f"错误: {CONFIG_FILE} 缺少 sites 数组，无法注入。")
        return

    # 幂等：先移除已存在的同 key 条目，避免重复注入
    custom_keys = {s["key"] for s in CUSTOM_SITES}
    before = len(sites)
    sites = [s for s in sites if not (isinstance(s, dict) and s.get("key") in custom_keys)]
    removed = before - len(sites)

    # 前插到数组首位，字段保持原样，不做任何补全
    sites = CUSTOM_SITES + sites
    config["sites"] = sites

    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=4, ensure_ascii=False)

    print(f"注入完成: 移除旧条目 {removed} 个, sites 首位新增 {len(CUSTOM_SITES)} 个自定义站点, 当前 sites 共 {len(sites)} 个。")


if __name__ == "__main__":
    main()
