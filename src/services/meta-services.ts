// ===== Service meta =====
//
// Endpoint non-domain yang dipakai perkakas, bukan user: hash kontrak, dan nanti hal-hal
// sejenis yang tidak punya rumah di domain mana pun.

import { getContractHash } from '../utils/contract-hash'
import type { ContractHashDto } from '../../shared/contracts'

/**
 * Hash sha256 folder shared/, dibandingkan kedua app Next saat boot dev dengan hash
 * salinannya di src/types/contracts/ (R12 — drift kontrak antar tiga repo).
 *
 * Tidak menyentuh database dan tidak butuh autentikasi: nilainya sudah ada di bundle FE
 * yang di-commit, jadi tidak ada yang bocor dengan menyajikannya terbuka.
 */
export async function getContractHashInfo(): Promise<ContractHashDto> {
  return getContractHash()
}
