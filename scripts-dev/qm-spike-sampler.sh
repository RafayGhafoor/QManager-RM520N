#!/bin/sh
# =============================================================================
# qm-spike-sampler.sh — WHO is on the CPU in each second (whole box)
# =============================================================================
# Answers "the box swings 38-80 %, what is it?" rather than "what does the
# poller cost". Every ~1 s it records the system busy counters from /proc/stat
# and every process's utime+stime+cutime+cstime (so a daemon's reaped helpers
# are charged to the daemon, which is the attribution that matters for a shell
# daemon). Analyse with the `analyse` mode below.
#
# COST, and why it matters: one sample = one `cat` of ~220 /proc/<pid>/stat
# files + one awk. Measured 2026-10-22 on the RG520N-EB: the sampler itself is
# ~14 % of one core and stretches the period to ~1.33 s. It shows up as a
# long-lived `sh` row — identify it by pid and subtract it before quoting a
# box total.
#
# USAGE (on the device; writes only /tmp/spk)
#   setsid nohup sh qm-spike-sampler.sh run 300 </dev/null >/dev/null 2>&1 &
#   sh qm-spike-sampler.sh analyse        # after /tmp/spk/done exists
# POSIX sh / BusyBox ash only.
# =============================================================================
D=/tmp/spk
case "${1:-run}" in
run)
DUR=${2:-300}; rm -rf $D; mkdir -p $D
i=0
while [ $i -le $DUR ]; do
  read -r c u n s idl iow irq sirq rest < /proc/stat
  { echo "CPU $((u+n+s+irq+sirq)) $((u+n+s+irq+sirq+idl+iow))"
    cat /proc/[0-9]*/stat 2>/dev/null | awk '{ s=$0; o=index(s,"("); c=substr(s,o+1); e=0
         for (k=length(c); k>0; k--) if (substr(c,k,1)==")") { e=k; break }
         comm=substr(c,1,e-1); gsub(/ /,"_",comm); rest=substr(c,e+2); split(rest,f," ")
         print $1, comm, f[12]+f[13]+f[14]+f[15], f[2] }'; } > $D/s.$i
  i=$((i+1)); sleep 1
done
echo done > $D/done
;;
analyse)
N=$(ls $D | grep -c '^s\.'); N=$((N-1))
i=1; : > $D/series
while [ $i -le $N ]; do
  awk -v sec=$i 'NR==FNR { if ($1=="CPU") { b0=$2; t0=$3 } else { a[$1]=$3; n[$1]=$2 } ; next }
       $1=="CPU" { busy=($2-b0)*100/(($3-t0)>0?($3-t0):1); next }
       { d=$3-(($1 in a)?a[$1]:$3); if (d>0) top[$2]+=d }
       END { line=""; for (k in top) line=line " " k ":" top[k]; printf "%d %.0f%s\n", sec, busy, line }' $D/s.$((i-1)) $D/s.$i >> $D/series
  i=$((i+1))
done
echo "=== busy% distribution (seconds) ==="
awk '{b=int($2/10)*10; h[b]++} END {for (k in h) printf "%3d-%3d%%: %d\n", k, k+9, h[k]}' $D/series | sort -n
echo "=== mean busy ==="; awk '{s+=$2} END {printf "%.1f%% over %d s\n", s/NR, NR}' $D/series
echo "=== who is busy in seconds >= 50% (ticks summed, 1 tick = 1% of a second) ==="
awk '$2>=50 { n++; for (i=3;i<=NF;i++) { split($i,a,":"); t[a[1]]+=a[2] } } END { printf "spike seconds: %d\n", n; for (k in t) printf "%6d %s\n", t[k], k }' $D/series | sort -rn | head -25
echo "=== who is busy in seconds < 30% ==="
awk '$2<30 { n++; for (i=3;i<=NF;i++) { split($i,a,":"); t[a[1]]+=a[2] } } END { printf "quiet seconds: %d\n", n; for (k in t) printf "%6d %s\n", t[k], k }' $D/series | sort -rn | head -12
echo "=== top 15 busiest seconds with their top 5 contributors ==="
sort -k2 -rn $D/series | head -15 | awk '{ printf "t=%s %s%%:", $1, $2; m=0; delete t; for (i=3;i<=NF;i++){split($i,a,":"); t[a[1]]=a[2]} ; for (j=0;j<5;j++){best="";bv=0; for (k in t) if (t[k]>bv){bv=t[k];best=k}; if(best!=""){printf " %s=%d", best, bv; delete t[best]}} print "" }'
echo "=== whole window, per process (ticks incl. reaped children; pids alive at both ends) ==="
awk 'NR==FNR { if ($1!="CPU") a[$1]=$3; next } $1!="CPU" && ($1 in a) { d=$3-a[$1]; if (d>0) printf "%6d pid=%s %s ppid=%s\n", d, $1, $2, $4 }' $D/s.0 $D/s.$N | sort -rn | head -25
awk '$1=="CPU"{print $2, $3}' $D/s.0 $D/s.$N | awk 'NR==1{b=$1;t=$2} NR==2{printf "window: busy %.1f%% of %d ticks\n", ($1-b)*100/($2-t), $2-t}'
;;
esac
