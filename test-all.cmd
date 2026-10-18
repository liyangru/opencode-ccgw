@echo off
rem ccgw offline regression runner.
rem Every suite below is a local simulation: no upstream calls, no quota use.
rem Exit code 0 means all green.
setlocal enabledelayedexpansion
set FAIL=0
for %%T in (
  test-errors
  test-protocol-regressions
  test-cooldowns
  test-budget
  test-images
  test-egress
  test-cancel
  test-plugin-readiness
  test-silent-node
  test-direct-ipv6
) do (
  echo.
  echo === %%T ===
  node --test %%T.mjs
  if errorlevel 1 set FAIL=1
)
echo.
echo === test-ranking ^(plain script^) ===
node test-ranking.mjs
if errorlevel 1 set FAIL=1
echo.
if "!FAIL!"=="1" (echo OFFLINE SUITE: FAILED) else (echo OFFLINE SUITE: ALL GREEN)
exit /b !FAIL!
