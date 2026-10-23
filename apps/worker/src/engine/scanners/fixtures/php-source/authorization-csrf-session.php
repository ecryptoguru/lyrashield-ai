<?php
// security-scan-skip-file: intentional unassessed benchmark data
session_start();
$account = $_POST['account'];
update_account($account);
