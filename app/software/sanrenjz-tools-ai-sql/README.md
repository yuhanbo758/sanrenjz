# AI SQL 助手

按 MySQL、PostgreSQL、SQLite、SQL Server、Oracle 方言生成、解释和优化 SQL。AI 结果分区展示 SQL 与说明，可分别复制全文或 SQL。

本地工具：格式化 SQL、检查常见高风险写法、为单条只读查询生成查询计划命令。这些工具不调用模型；风险检查是静态提示，不能代替数据库权限控制或实际执行计划。SQL Server 计划命令中的 `GO` 需要在支持批次分隔的客户端中使用；Oracle `EXPLAIN PLAN` 会在目标数据库写入计划表记录，插件自身不会执行命令。

查询计划命令依据各数据库官方文档：[MySQL EXPLAIN](https://dev.mysql.com/doc/refman/8.4/en/explain.html)、[PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html)、[SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)、[SQL Server SHOWPLAN_XML](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql)、[Oracle EXPLAIN PLAN](https://docs.oracle.com/en/database/oracle/oracle-database/26/tgsql/generating-and-displaying-execution-plans.html)。

使用共享 AI Runtime 和系统安全存储；插件不会自动修改文件、提交 Git 或连接数据库。
