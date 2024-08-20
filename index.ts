import express from "express"
import router from "./src/routes"

import "./src/services/Tensorflow.service"
import "./src/services/CryproCompare.service"
import "./src/services/MoneroWallet.service"
import "./src/services/EtheriumWallet.service"
import "./src/services/DigitalOcean.storage.service"

const initApp = async () => {

	const app = express()

	const port = process.env.PORT || 3000

	app.use(express.json())
  router(app)

	app.listen(port, () => {
		console.log(`Server running on port ${port}`)
	})
}

initApp()
