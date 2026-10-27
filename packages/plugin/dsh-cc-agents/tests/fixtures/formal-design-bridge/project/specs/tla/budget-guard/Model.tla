-------------------------- MODULE Model --------------------------
EXTENDS Naturals
CONSTANT Budget, Reserved, Amount
VARIABLES reserved

vars == reserved
Init == reserved = Reserved
AdmitReservation == Reserved <= Budget /\ Amount <= Budget - Reserved
Next == UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == reserved \in 0..Budget
Bridge_boundary_exhaustion == Reserved + Amount = 10
Bridge_zero_request == AdmitReservation => Reserved + Amount = 3
Bridge_excess_by_one == ~AdmitReservation
==================================================================
