import { Router } from "express"
import { format } from "date-fns"
import routes from "../config/routes.config"
import HealthService from "../services/HealthService"

export default () => {
	const router = Router()
	router.get(routes.REST.HEALTH, (req, res) => {
		const now = new Date()
		// shallow: liveness only, used by anything that must never see a 5xx from a slow dependency
		if (req.query.deep !== "1") {
			res.json({ status: "ok", date: format(now, "yyyy-MM-dd HH:mm:ss") })
			return
		}
		// deep: rolled-up ok | degraded | down, 503 when down, so an existing uptime checker alarms with no new infra
		const report = HealthService.getReport()
		res.status(report.status === "down" ? 503 : 200).json({ date: format(now, "yyyy-MM-dd HH:mm:ss"), ...report })
	})
	return router
}
