import type { ApprovalDTO, Role } from '@unkillable/shared';
export function actionableApprovals(
  rows: ApprovalDTO[],
  userId: string,
  role: Role,
  now: number,
) {
  return rows.filter(
    (a) =>
      a.status === 'pending' &&
      !a.reviews.some((r) => r.actorId === userId) &&
      (role === 'admin' ||
        (role === 'approver' && a.proposedAction.kind !== 'moderation')) &&
      (!a.sla || Date.parse(a.sla.expireAt) > now),
  );
}
export function approvalAlertStage(a: ApprovalDTO, role: Role) {
  return a.sla?.escalatedAt && a.sla.escalateRole === role
    ? 'escalated'
    : a.sla?.remindedAt
      ? 'reminder'
      : 'pending';
}
export function approvalAlertKey(a: ApprovalDTO, role: Role) {
  return `${a.id}:${a.version}:${approvalAlertStage(a, role)}`;
}
