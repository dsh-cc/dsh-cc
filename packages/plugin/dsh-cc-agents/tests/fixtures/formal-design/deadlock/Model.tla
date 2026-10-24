---- MODULE Model ----
EXTENDS Naturals, TLC
VARIABLE x
Init == x = 0
Next == FALSE
TypeOK == x \in 0..1
Spec == Init /\ [][Next]_x

====
