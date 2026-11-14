import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Button } from "@/ui/button"
import { api } from "../data/api"
import { PageHeader, PageShell, Panel } from "./page-layout"

const states: Record<string, string> = {
  WAITING: "等待 20:00",
  CHECKING: "正在检查环境",
  CHECKED: "等待参数准备",
  PREPARING: "正在验证座位",
  READY: "准备就绪",
  RUNNING: "正在核对预约",
  SUBMITTING_162: "正在预约 162",
  SUBMITTING_157: "正在预约 157",
  SUCCESS: "预约成功",
  FAILED: "自动预约失败",
  UNKNOWN: "结果待确认",
  STOPPED: "已停止，等待手动接管",
  AUTH_REQUIRED: "需要重新认证或校准时钟",
  LIMITED: "触发限流，已停止",
  EXISTING: "目标时段已有预约",
}
export function StrictPage() {
  const client = useQueryClient()
  const [showLogs, setShowLogs] = useState(false)
  const [notice, setNotice] = useState("")
  const status = useQuery({ queryKey: ["strict"], queryFn: api.strictStatus, refetchInterval: 3000 })
  const logs = useQuery({
    queryKey: ["strict-logs"],
    queryFn: () => api.audit(30),
    enabled: showLogs,
    refetchInterval: showLogs ? 5000 : false,
  })
  const action = useMutation({
    mutationFn: async (kind: string) => {
      if (kind === "start") return api.strictStart()
      if (kind === "stop") return api.strictStop()
      if (kind === "daily") return api.strictDaily(!status.data?.daily)
      const result = await api.strictLogin()
      setNotice(
        result.valid
          ? result.clockSane
            ? "登录有效，时钟检查通过"
            : "登录有效；时钟检查未通过，请检查服务器 NTP"
          : "登录失效，请重新登录",
      )
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["strict"] })
    },
  })
  const data = status.data
  const task = data?.tasks.find((t) => t.date === data.targetDate)
  const interrupted =
    task &&
    ["CHECKING", "PREPARING", "RUNNING", "SUBMITTING_162", "SUBMITTING_157"].includes(task.state) &&
    Date.now() / 1000 - task.updatedAt > 120
  return (
    <PageShell>
      <PageHeader title="一键抢座" eyebrow="后台常驻执行，手机锁屏或浏览器退出不影响任务。" />
      <Panel title="预约目标" contentClassName="space-y-5 p-4 sm:p-6">
        <h2 className="text-xl font-semibold">宋韵云图（四楼）</h2>
        <p>162 优先 / 157 备用 · 1 人</p>
        <p>08:00–22:00 · 14 小时</p>
        <p>目标日期：{data?.targetDate ?? "读取中"}（北京时间当天 +2 天）</p>
        <div role="status" aria-live="polite" className="rounded-lg border p-4">
          <strong>
            {interrupted ? "结果待确认／任务可能中断" : (states[task?.state ?? ""] ?? "未启动")}
          </strong>
          <p className="mt-2 break-words">{task?.message ?? "每天 20:00 开放预约，只尝试 162 和 157。"}</p>
          {interrupted && <p>任务不会自动重发。请查看官方预约记录或手动接管。</p>}
        </div>
        {!data?.writesAllowed && <p>当前为无真实写入验收模式。真实预约未验证，每日自动预约保持关闭。</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Button
            className="min-h-12"
            disabled={action.isPending || !data}
            onClick={() => action.mutate("start")}
          >
            一键开始抢座
          </Button>
          <Button
            className="min-h-12"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate("stop")}
          >
            取消待命 / 停止任务
          </Button>
          <Button
            className="min-h-12"
            variant="outline"
            disabled={action.isPending || (!data?.daily && (!data?.validated || !data?.writesAllowed))}
            onClick={() => action.mutate("daily")}
          >
            {data?.daily ? "关闭每日自动预约" : "启用每日自动预约"}
          </Button>
          <Button
            className="min-h-12"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate("login")}
          >
            检查登录状态
          </Button>
          <Button className="min-h-12" variant="outline" onClick={() => setShowLogs(!showLogs)}>
            查看运行日志
          </Button>
          <Button
            className="min-h-12"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate("stop")}
          >
            手动接管
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          停止会关闭每日自动预约，不取消已有预约。已发出的请求可能仍完成，同一目标任务不会因重复点击或重启而重发。
        </p>
        <div className="flex flex-wrap gap-5">
          <Link to="/bookings" className="underline">
            查看预约结果
          </Link>
          <a
            href="https://hdu.huitu.zhishulib.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            打开官方预约页面
          </a>
        </div>
        {notice && <p role="status">{notice}</p>}
        {(action.error || status.error) && <p role="alert">{(action.error || status.error)?.message}</p>}
      </Panel>
      {showLogs && (
        <Panel title="运行日志" contentClassName="space-y-3 p-4">
          <h2 className="font-semibold">运行日志</h2>
          {logs.error && <p role="alert">日志读取失败</p>}
          {logs.data?.events
            .filter((e) => e.event === "strict_transition")
            .map((e) => (
              <div key={e.id} className="break-words border-b py-2 text-sm">
                <p>
                  {e.createdAt} · {String(e.payload.state ?? "")}
                </p>
                <p>{String(e.payload.message ?? "")}</p>
              </div>
            ))}
        </Panel>
      )}
    </PageShell>
  )
}
