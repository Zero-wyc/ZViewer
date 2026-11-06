package db

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode"
)

// ColumnSpec 是 schema.sql 里一列的结构化描述。
//
// 只解析「补列」需要的信息（列名、类型、可空性、默认值），不重建 CHECK / COLLATE：
// 那些约束只影响**新写入**，而补列时 SQLite 本来也不允许带表级约束。
type ColumnSpec struct {
	Name string
	Type string
	// NotNull 表示 DDL 里带 `NOT NULL`。
	NotNull bool
	// DefaultExpr 是默认值里的**常量**字面量（已剥掉 TypeORM 包的外层括号）。
	// 只有 HasDefault 为 true 时才有意义。
	DefaultExpr string
	HasDefault  bool
	PrimaryKey  bool
	Unique      bool
}

// TableSpec 是 schema.sql 里一张表的结构，CreateSQL 保留原始语句。
type TableSpec struct {
	Name      string
	Columns   []ColumnSpec
	CreateSQL string
}

// Column 按列名查找。
func (t TableSpec) Column(name string) (ColumnSpec, bool) {
	for _, c := range t.Columns {
		if c.Name == name {
			return c, true
		}
	}
	return ColumnSpec{}, false
}

// AlterDDL 生成给已有表补这一列的语句。
//
// 第二个返回值为 false 表示 SQLite 的 `ALTER TABLE ADD COLUMN` 不允许这样补
// （https://sqlite.org/lang_altertable.html）：
//   - 不能加 PRIMARY KEY / UNIQUE 列；
//   - `NOT NULL` 必须同时给一个**常量**默认值；
//   - 默认值不能是 CURRENT_TIME/DATE/TIMESTAMP，也不能是括号里的表达式。
//
// 这种列只能靠重建表来补，本工具不做——如实报错让人先升到 4.8.0 更安全。
func (c ColumnSpec) AlterDDL(table string) (string, bool) {
	if c.PrimaryKey || c.Unique || (c.NotNull && !c.HasDefault) {
		return "", false
	}
	parts := []string{quoteIdent(c.Name), c.Type}
	if c.NotNull {
		parts = append(parts, "NOT NULL")
	}
	if c.HasDefault {
		parts = append(parts, "DEFAULT "+c.DefaultExpr)
	}
	return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s", quoteIdent(table), strings.Join(parts, " ")), true
}

var (
	schemaOnce   sync.Once
	schemaTables []TableSpec
	schemaErr    error
)

// Schema 返回 schema.sql 的结构化视图；进程内只解析一次。
//
// 它是列校验与补列的唯一依据，因此解析失败必须当成硬错误传播出去——
// 解析出一张空表会让 VerifySchema 静默放行，比直接报错危险得多。
func Schema() ([]TableSpec, error) {
	schemaOnce.Do(func() {
		schemaTables, schemaErr = parseSchema(schemaSQL)
	})
	return schemaTables, schemaErr
}

var createTablePattern = regexp.MustCompile(`(?s)^CREATE TABLE IF NOT EXISTS "([^"]+)" \((.*)\)$`)

// parseSchema 把 schema.sql 拆成表 → 列。
//
// 依赖的格式约定来自 TypeORM 的生成物，很稳定：
// 每张表一条 `CREATE TABLE IF NOT EXISTS "名" (...)`，每个列占一行、
// 以 `"列名" 类型` 开头，表级约束单独一行且以 CONSTRAINT 开头。
func parseSchema(script string) ([]TableSpec, error) {
	var tables []TableSpec
	for _, stmt := range splitStatements(script) {
		m := createTablePattern.FindStringSubmatch(stmt)
		if m == nil {
			// 只允许出现建表语句：schema.sql 里多出别的语句说明有人手改了它，
			// 宁可在测试/启动时炸掉，也不要让它悄悄不生效。
			if strings.HasPrefix(strings.ToUpper(stmt), "CREATE TABLE") {
				return nil, fmt.Errorf("无法解析建表语句: %s", firstLine(stmt))
			}
			continue
		}
		table := TableSpec{Name: m[1], CreateSQL: stmt}
		for _, raw := range strings.Split(m[2], "\n") {
			line := strings.TrimSpace(raw)
			if line == "" || strings.HasPrefix(strings.ToUpper(line), "CONSTRAINT") {
				continue
			}
			if !strings.HasPrefix(line, `"`) {
				continue
			}
			col, err := parseColumn(line)
			if err != nil {
				return nil, fmt.Errorf("解析 %s 的列失败: %w", table.Name, err)
			}
			table.Columns = append(table.Columns, col)
		}
		if len(table.Columns) == 0 {
			return nil, fmt.Errorf("表 %s 没有解析出任何列", table.Name)
		}
		tables = append(tables, table)
	}
	if len(tables) == 0 {
		return nil, fmt.Errorf("schema.sql 里没有解析出任何表")
	}
	return tables, nil
}

// parseColumn 解析一行列定义，例如：
//
//	"status" varchar CHECK( "status" IN ('active') ) NOT NULL DEFAULT ('active'),
//	"roomId" varchar(50) PRIMARY KEY NOT NULL,
//	"metadata" text,
func parseColumn(line string) (ColumnSpec, error) {
	end := strings.Index(line[1:], `"`)
	if end < 0 {
		return ColumnSpec{}, fmt.Errorf("列名没有闭合的引号: %s", line)
	}
	col := ColumnSpec{Name: line[1 : 1+end]}

	rest := strings.TrimSpace(line[2+end:])
	rest = strings.TrimSuffix(rest, ",")
	if rest == "" {
		return ColumnSpec{}, fmt.Errorf("列 %s 缺少类型", col.Name)
	}

	// 类型是第一段（varchar(50) 这类带长度的一整段里没有空格）。
	typeEnd := strings.IndexFunc(rest, unicode.IsSpace)
	if typeEnd < 0 {
		typeEnd = len(rest)
	}
	col.Type = rest[:typeEnd]
	rest = strings.TrimSpace(rest[typeEnd:])

	upper := strings.ToUpper(rest)
	col.NotNull = strings.Contains(upper, "NOT NULL")
	col.PrimaryKey = strings.Contains(upper, "PRIMARY KEY")
	col.Unique = strings.Contains(upper, "UNIQUE")

	if i := strings.Index(upper, "DEFAULT"); i >= 0 {
		if expr, ok := splitDefaultExpr(rest[i+len("DEFAULT"):]); ok && isConstantDefault(expr) {
			col.DefaultExpr, col.HasDefault = expr, true
		}
	}
	return col, nil
}

// splitDefaultExpr 取出 DEFAULT 后面的表达式：括号包着的按括号配对切，
// 裸值按空白切。返回的值仍保留原始引号（SQL 字面量要原样回写）。
func splitDefaultExpr(tail string) (string, bool) {
	tail = strings.TrimSpace(tail)
	if tail == "" {
		return "", false
	}
	if tail[0] != '(' {
		end := strings.IndexFunc(tail, unicode.IsSpace)
		if end < 0 {
			end = len(tail)
		}
		return tail[:end], true
	}
	depth := 0
	for i := 0; i < len(tail); i++ {
		switch tail[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return strings.TrimSpace(tail[1:i]), true
			}
		}
	}
	return "", false
}

// isConstantDefault 判断默认值能否出现在 ALTER TABLE ADD COLUMN 里。
//
// 括号里的表达式（datetime('now')）和 CURRENT_* 关键字都不行——
// SQLite 明确规定补列时的默认值必须是常量。
func isConstantDefault(expr string) bool {
	expr = strings.TrimSpace(expr)
	if expr == "" || strings.ContainsAny(expr, "()") {
		return false
	}
	switch strings.ToUpper(expr) {
	case "CURRENT_TIME", "CURRENT_DATE", "CURRENT_TIMESTAMP", "NULL":
		return false
	}
	return true
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
