<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$rows = DB::select('SELECT * FROM accounts WHERE id = ?', [request('account_id')]);
