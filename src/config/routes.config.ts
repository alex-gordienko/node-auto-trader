import { IRoutesConfig } from "../types/basic.types";

const routes: IRoutesConfig = {
  REST: {
    HEALTH: "/api/v1/health",
    SAVE_HISTORY: "/api/v1/save/history",
    LEARN_TENSORFLOW: "/api/v1/learn/tensorflow",
    GET_PREDICTION: '/api/v1/predict/tensorflow'
  },
};

export default routes
