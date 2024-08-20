import { Router } from "express"
import { format } from "date-fns"
import routes from "../config/routes.config"

export default () => {
	const router = Router()
	router.get(routes.REST.HEALTH, (req, res) => {
		const now = new Date()
		res.json({
			status: "ok",
			date: format(now, "yyyy-MM-dd HH:mm:ss"),
		})
	})
	return router
}
