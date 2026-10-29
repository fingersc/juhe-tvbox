# -*- coding: utf-8 -*-
"""
步骤 4：在流水线生成的 config.json 中注入自定义配置：
																				 
  自定义站点前插到 sites 数组首位

运行时机：必须在 update_config.py / test_api_availability.py / separate_sources.py
全部执行完毕之后、git-auto-commit 之前，否则会被前序步骤覆盖。
幂等：站点先按 key 删除旧条目再前插，不会重复。
"""
import json
import os

CONFIG_FILE = 'config.json'

																		
																								   

# 自定义站点（前插到 sites[0]，字段保持原样）
CUSTOM_SITES = [
    {
        "key": "Douban",
        "name": "豆瓣影视库",
        "type": 3,
        "api": "https://cnb.cool/fingersc/iptv-sync/-/git/raw/main/douban.js",
        "indexs": 1,
        "searchable": 0,
        "quickSearch": 0,
        "changeable": 0
    }
]


def main():
    if not os.path.exists(CONFIG_FILE):
        print(f"错误: 找不到 {CONFIG_FILE}，请确认前序步骤已生成。")
        return

    with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)

													  
							  
											 

    # sites 首位注入
    sites = config.get("sites")
    if not isinstance(sites, list):
        print(f"错误: {CONFIG_FILE} 缺少 sites 数组，无法注入。")
        return
    custom_keys = {s["key"] for s in CUSTOM_SITES}
    before = len(sites)
    sites = [s for s in sites if not (isinstance(s, dict) and s.get("key") in custom_keys)]
    removed = before - len(sites)
    sites = CUSTOM_SITES + sites
    config["sites"] = sites

    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=4, ensure_ascii=False)

    print(f"注入完成: 移除旧站点 {removed} 个, 前插自定义站点 {len(CUSTOM_SITES)} 个, sites 共 {len(sites)} 个。")


if __name__ == "__main__":
    main()
