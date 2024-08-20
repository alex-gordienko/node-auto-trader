import { Express } from "express";
import health from "./health";
import restCommands from "./restCommands"


export default (app: Express) => {
  app.use(health())
  app.use(restCommands())
}
