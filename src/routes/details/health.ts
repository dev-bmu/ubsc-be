import express from 'express'
import * as ctrl from '../../controller/health-controller'

// Prefix penuh (/api/health) dideklarasikan di public-api.ts.
const healthRoutes = express.Router()

healthRoutes.get('/', ctrl.health)
healthRoutes.get('/deep', ctrl.healthDeep)

export default healthRoutes
