<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$id = request('account_id');
$rows = DB::select('SELECT * FROM accounts WHERE id=' . $id);
