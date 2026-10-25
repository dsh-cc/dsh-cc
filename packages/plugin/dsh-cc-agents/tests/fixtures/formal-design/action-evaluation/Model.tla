---- MODULE Model ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = 1
TypeOK == x \in 0..1
Bad == [] [(1 \div (1 - x')) = 1]_x
Spec == Init /\ [][Next]_x
====
