import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import sharesRouter from "./shares.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sharesRouter);

export default router;
