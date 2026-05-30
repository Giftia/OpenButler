REMOTE_FACT_BOUNDARY = "MineContext 和 OpenButler 只能说明本机操作线索；远程仓库、CI、云效任务、部署和线上接口状态必须回源实时验证。"


def merge_boundary(*parts: str) -> str:
    return " ".join(part.strip() for part in parts if part and part.strip())
