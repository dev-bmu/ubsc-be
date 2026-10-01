import { RequestHandler } from 'express'
import {
  createAdminMembership,
  createCustomerAccount,
  createMembershipPlan,
  destroyMembership,
  destroyMembershipPlan,
  listAdminMembershipPlans,
  listAdminMemberships,
  markMembershipPaid,
  renewAdminMembership,
  searchCustomers,
  updateMembershipPlan,
  updateMembershipStatus
} from '../services/membership-admin-services'
import { requireUser } from '../utils/request-user'
import { ok } from '../utils/respond'

// ===== Controller admin Membership / Paket / Pencarian customer (Fase 8C) =====
// Tipis: baca params/body/query/user, panggil service, balas ok(). Permission dicek di baris route
// (requirePermission / requireAnyPermission di details/admin-*.ts), tidak pernah di sini.

// ===== Memberships =====

export const membershipsIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await listAdminMemberships())
  } catch (error) {
    next(error)
  }
}

export const membershipsStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await createAdminMembership(req.body, requireUser(req).id), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const membershipsRenew: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await renewAdminMembership(String(req.params.id), req.body, requireUser(req).id), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const membershipsMarkPaid: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await markMembershipPaid(String(req.params.id), requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

export const membershipsUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await updateMembershipStatus(String(req.params.id), req.body, requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

export const membershipsDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await destroyMembership(String(req.params.id), requireUser(req).id))
  } catch (error) {
    next(error)
  }
}

// ===== Customers =====

export const customersSearch: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await searchCustomers(req.query))
  } catch (error) {
    next(error)
  }
}

export const customersStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await createCustomerAccount(req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

// ===== Plans =====

export const plansIndex: RequestHandler = async (_req, res, next) => {
  try {
    ok(res, await listAdminMembershipPlans())
  } catch (error) {
    next(error)
  }
}

export const plansStore: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await createMembershipPlan(req.body), undefined, 201)
  } catch (error) {
    next(error)
  }
}

export const plansUpdate: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await updateMembershipPlan(String(req.params.id), req.body))
  } catch (error) {
    next(error)
  }
}

export const plansDestroy: RequestHandler = async (req, res, next) => {
  try {
    ok(res, await destroyMembershipPlan(String(req.params.id)))
  } catch (error) {
    next(error)
  }
}
