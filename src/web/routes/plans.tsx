import { createRoute } from "@tanstack/react-router"

import { useQuery } from "@tanstack/react-query"
import { api } from "../data/api"
import { StrictPage } from "../components/strict-page"
import { PlansPage } from "../components/plans-page"
import { rootRoute } from "./__root"

export const plansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plans",
  component: function PlansRoute() {
    const mode = useQuery({ queryKey: ["strict"], queryFn: api.strictStatus, retry: false })
    if (mode.isPending) return <p role="status">正在读取运行模式…</p>
    if (mode.isError) return <p role="alert">无法读取后台运行模式，请刷新重试。</p>
    return mode.data?.enabled ? <StrictPage /> : <PlansPage />
  },
})
